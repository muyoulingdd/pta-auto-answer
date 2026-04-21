// ==UserScript==
// @name         编程题目自动答题助手（多区域支持版）
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  支持多题目区域+API配置的自动答题脚本（悬浮框美化版）
// @author       你
// @match        https://pintia.cn/problem-sets/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *  // 允许所有API域名（因URL由用户配置）
// ==/UserScript==

(function() {
    'use strict';

    // 存储区域选择器及API配置
    let questionSelectors = GM_getValue('questionSelectors') ? JSON.parse(GM_getValue('questionSelectors')) : [];
    let inputSelector = GM_getValue('inputSelector') || null;
    let apiKey = GM_getValue('apiKey') || '';
    let apiUrl = GM_getValue('apiUrl') || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    let apiModel = GM_getValue('apiModel') || 'your-bailian-model-id';
    let enableThinking = GM_getValue('enableThinking') === true || GM_getValue('enableThinking') === 'true';
    let panelPosition = GM_getValue('panelPosition') ? JSON.parse(GM_getValue('panelPosition')) : { top: 20, right: 20 };
    let panelMode = GM_getValue('panelMode') || 'auto';
    let apiConfigCollapsed = GM_getValue('apiConfigCollapsed') === true || GM_getValue('apiConfigCollapsed') === 'true';
    let panel = null; // 操作面板全局引用
    let inputLogs = [];
    let lastMergedQuestionText = '';
    let isAutoRunning = false;
    // 新增全局语言变量，默认Python
    let selectedLanguage = GM_getValue('selectedLanguage') || 'Python';

    function buildSystemPrompt(language) {
        const promptMap = {
            C: '你是解题助手。输出可直接提交的C语言代码。',
            'C++': '你是解题助手。输出可直接提交的C++代码。',
            Java: '你是解题助手。输出可直接提交的Java代码。',
            Python: '你是解题助手。输出可直接提交的Python代码。',
            SQL: '你是解题助手。输出可直接提交的SQL答案。'
        };

        const formatRequirement = '你必须只返回一个合法 JSON 对象，格式严格为 {"code":"..."}。code 字段必须保留完整的多行代码格式：需要换行的地方必须使用 \\n，缩进必须保留空格或 \\t，绝对不要把整段代码压缩成一行。除了这个 JSON 对象外，不要输出 Markdown，不要输出解释，不要输出额外字段。';

        return `${promptMap[language] || promptMap.Python}${formatRequirement}`;
    }

    function buildUserPrompt(questionText, language) {
        return `请解答这道${language}题目并按要求返回。\n题目如下：\n${questionText}`;
    }

    function buildUserMultimodalPrompt(questionText, language, mediaSummary = {}) {
        const imageCount = mediaSummary.imageCount || 0;
        const screenshotCount = mediaSummary.screenshotCount || 0;
        const mediaHint = imageCount || screenshotCount
            ? '\n已附带题面图片和区域截图。'
            : '';

        return `请解答这道${language}题目并按要求返回。${mediaHint}\n题目如下：\n${questionText}`;
    }

    function splitTableLikeCells(line) {
        return (line || '')
            .split(/\t+| {2,}/)
            .map((cell) => normalizeQuestionSectionText(cell))
            .filter(Boolean);
    }

    function extractOutputHeaderHints(questionText) {
        const lines = normalizeQuestionSectionText(questionText).split('\n');
        const hints = [];
        const seen = new Set();

        for (let i = 0; i < lines.length; i += 1) {
            const line = normalizeQuestionSectionText(lines[i]);
            if (!/输出样例|输出示例/.test(line)) continue;

            for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
                const candidateLine = normalizeQuestionSectionText(lines[j]);
                if (!candidateLine) continue;
                if (/^(输入样例|输入示例|样例说明|说明|例如)[:：]?$/.test(candidateLine)) continue;

                const cells = splitTableLikeCells(candidateLine);
                if (cells.length >= 2) {
                    const hint = cells.join(' | ');
                    if (!seen.has(hint)) {
                        seen.add(hint);
                        hints.push(hint);
                    }
                    break;
                }
            }
        }

        return hints;
    }

    function stripCodeFence(answer) {
        if (!answer) return '';

        const fencedMatch = answer.match(/```(?:\w+)?\s*([\s\S]*?)```/);
        if (fencedMatch) {
            return fencedMatch[1].trim();
        }

        return answer.trim();
    }

    function normalizeAnswerText(answer) {
        return stripCodeFence(answer)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\u2028|\u2029/g, '\n')
            .trim();
    }

    function normalizeCodeText(answer) {
        if (!answer) return '';

        const maybeUnescaped = answer.includes('\n')
            ? answer
            : answer
                .replace(/\\r\\n/g, '\n')
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t');

        return maybeUnescaped
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\u2028|\u2029/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function toAbsoluteUrl(url) {
        if (!url) return '';
        try {
            return new URL(url, window.location.href).href;
        } catch (error) {
            return url;
        }
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('读取 Blob 失败'));
            reader.readAsDataURL(blob);
        });
    }

    async function urlToDataUrl(url) {
        const response = await fetch(url, {
            mode: 'cors',
            credentials: 'include'
        });
        if (!response.ok) {
            throw new Error(`图片下载失败：${response.status}`);
        }
        const blob = await response.blob();
        return blobToDataUrl(blob);
    }

    function shouldUseMultimodalPayload() {
        return true;
    }

    function getRenderableQuestionImages(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll('img'))
            .filter((img) => {
                const src = img.currentSrc || img.src || '';
                if (!src) return false;
                const rect = img.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
    }

    function elementNeedsScreenshotFallback(container) {
        if (!container) return false;
        return !!container.querySelector('canvas, svg');
    }

    function normalizeQuestionSectionText(text) {
        return (text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function getElementVisualPosition(element) {
        const rect = element.getBoundingClientRect();
        return {
            top: Math.round(rect.top + window.scrollY),
            left: Math.round(rect.left + window.scrollX)
        };
    }

    function compareVisualEntries(a, b) {
        if (Math.abs(a.top - b.top) > 6) return a.top - b.top;
        if (Math.abs(a.left - b.left) > 6) return a.left - b.left;
        return a.index - b.index;
    }

    function extractTableText(tableElement) {
        const rows = Array.from(tableElement.querySelectorAll('tr'))
            .map((row) => Array.from(row.querySelectorAll('th, td'))
                .map((cell) => normalizeQuestionSectionText(cell.textContent))
                .filter(Boolean)
                .join('\t'))
            .filter(Boolean);

        return normalizeQuestionSectionText(rows.join('\n'));
    }

    function hasMeaningfulDirectText(element) {
        return Array.from(element.childNodes || [])
            .some((node) => node.nodeType === Node.TEXT_NODE && normalizeQuestionSectionText(node.textContent));
    }

    function extractOrderedQuestionSections(container) {
        if (!container) return [];

        const selector = [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'li', 'blockquote',
            'pre', 'table',
            '.cm-editor', '.cm-content'
        ].join(', ');
        const excludedAncestorSelector = 'pre, table, .cm-editor, .cm-content, p, li, blockquote, h1, h2, h3, h4, h5, h6, th, td';
        const candidates = [];
        let candidateIndex = 0;

        const pushCandidate = (element, explicitText = '') => {
            if (!element || !isElementVisible(element)) return;

            const text = normalizeQuestionSectionText(explicitText || (
                element.matches('table')
                    ? extractTableText(element)
                    : element.textContent
            ));

            if (!text) return;

            const { top, left } = getElementVisualPosition(element);
            candidates.push({
                text,
                top,
                left,
                index: candidateIndex++
            });
        };

        Array.from(container.querySelectorAll(selector)).forEach((element) => {
            if (element.matches('.cm-editor, .cm-content')) {
                const codeLines = Array.from(element.querySelectorAll('.cm-line'))
                    .map((line) => line.textContent.replace(/\u00a0/g, ' ').trimEnd())
                    .filter((line) => line.trim().length > 0);

                if (codeLines.length > 0) {
                    pushCandidate(element, codeLines.join('\n'));
                }
                return;
            }

            pushCandidate(element);
        });

        Array.from(container.querySelectorAll('div, span')).forEach((element) => {
            if (!isElementVisible(element)) return;
            if (element.closest(excludedAncestorSelector)) return;
            if (element.querySelector(selector)) return;
            if (!hasMeaningfulDirectText(element)) return;
            pushCandidate(element);
        });

        if (hasMeaningfulDirectText(container) && !container.querySelector(selector)) {
            pushCandidate(container);
        }

        if (candidates.length === 0) {
            const fallbackText = normalizeQuestionSectionText(container.textContent);
            if (!fallbackText) return [];
            const { top, left } = getElementVisualPosition(container);
            return [{ text: fallbackText, top, left, index: 0 }];
        }

        candidates.sort(compareVisualEntries);

        const mergedSections = [];
        const seenTexts = new Set();

        candidates.forEach((entry) => {
            if (seenTexts.has(entry.text)) return;
            seenTexts.add(entry.text);
            mergedSections.push(entry);
        });

        return mergedSections;
    }

    function mergeOrderedQuestionEntries(entries) {
        const seenSections = new Set();
        const orderedEntries = [...entries].sort(compareVisualEntries);
        const texts = [];

        orderedEntries.forEach((entry) => {
            const normalized = normalizeQuestionSectionText(entry?.text);
            if (!normalized || seenSections.has(normalized)) return;
            seenSections.add(normalized);
            texts.push(normalized);
        });

        return texts.join('\n\n').trim();
    }

    function splitNormalizedLines(text) {
        return normalizeQuestionSectionText(text)
            .split('\n')
            .map((line) => normalizeQuestionSectionText(line))
            .filter(Boolean);
    }

    function inferMediaLabelFromSections(entries = []) {
        const lines = entries.flatMap((entry) => splitNormalizedLines(entry?.text));
        const priorityPatterns = [
            /(?:^|\s)([A-Za-z_][A-Za-z0-9_]{0,40}表)(?:\s|:|：|$)/,
            /(?:^|\s)(输入样例|输出样例|表样例|示例数据|样例数据)(?:\s|:|：|$)/,
            /(?:^|\s)([^\n：:]{1,20}(?:样例|示例|结果|输出|输入|数据表|表结构))(?:\s|:|：|$)/
        ];

        for (const pattern of priorityPatterns) {
            for (const line of lines) {
                const match = line.match(pattern);
                if (match?.[1]) {
                    return match[1].trim();
                }
            }
        }

        return lines[0] || '题面图示';
    }

    function buildMediaContextText(entries = [], fallbackLabel = '题面图示') {
        const allLines = entries.flatMap((entry) => splitNormalizedLines(entry?.text));
        const preferredLines = [];
        const seen = new Set();
        const preferredPattern = /(表|样例|示例|输入|输出|字段|列|结构|说明|例如|结果|数据)/;

        allLines.forEach((line) => {
            if (!preferredPattern.test(line)) return;
            if (seen.has(line)) return;
            seen.add(line);
            preferredLines.push(line);
        });

        if (preferredLines.length === 0) {
            allLines.forEach((line) => {
                if (seen.has(line)) return;
                seen.add(line);
                preferredLines.push(line);
            });
        }

        const clippedLines = preferredLines.slice(0, 6);
        const merged = clippedLines.join('\n').slice(0, 320).trim();

        return merged || fallbackLabel;
    }

    function isMediaRichElement(element) {
        if (!element || !(element instanceof Element) || !isElementVisible(element)) return false;
        if (element.matches('img, table, canvas, svg')) return true;
        return !!element.querySelector('img, table, canvas, svg');
    }

    function isSampleLabelElement(element) {
        if (!element || !(element instanceof Element) || !isElementVisible(element)) return false;
        const text = normalizeQuestionSectionText(element.textContent);
        if (!text || text.length > 30) return false;
        return /(输出样例|输入样例|表样例|样例输出|样例输入|示例输出|示例输入)/.test(text);
    }

    function getNextVisibleSiblings(element, limit = 6) {
        const siblings = [];
        let current = element?.nextElementSibling || null;

        while (current && siblings.length < limit) {
            if (isElementVisible(current)) {
                siblings.push(current);
            }
            current = current.nextElementSibling;
        }

        return siblings;
    }

    function resolveSampleCaptureElement(labelElement, rootElement) {
        if (!labelElement || !rootElement) return null;

        const directSiblings = getNextVisibleSiblings(labelElement, 6);
        const directMatch = directSiblings.find((element) => isMediaRichElement(element));
        if (directMatch) return directMatch;

        const parentSiblings = getNextVisibleSiblings(labelElement.parentElement, 6);
        const parentMatch = parentSiblings.find((element) => isMediaRichElement(element));
        if (parentMatch) return parentMatch;

        const nearbyChildren = Array.from((labelElement.parentElement || rootElement).children || [])
            .filter((element) => element !== labelElement && isMediaRichElement(element));
        if (nearbyChildren.length > 0) return nearbyChildren[0];

        return null;
    }

    function resolveSampleCaptureContainer(labelElement, mediaElement, rootElement) {
        if (!labelElement || !mediaElement) return mediaElement;

        const candidateAncestors = [];
        let current = mediaElement;

        while (current && current !== rootElement && current instanceof Element) {
            candidateAncestors.push(current);
            current = current.parentElement;
        }

        for (const candidate of candidateAncestors) {
            if (!candidate.contains(labelElement)) continue;
            if (!isElementVisible(candidate)) continue;

            const rect = candidate.getBoundingClientRect();
            const textLength = normalizeQuestionSectionText(candidate.textContent).length;

            if (rect.height <= 900 && rect.width > 20 && textLength <= 1200) {
                return candidate;
            }
        }

        const sharedParent = labelElement.parentElement;
        if (sharedParent && sharedParent.contains(mediaElement) && isElementVisible(sharedParent)) {
            const rect = sharedParent.getBoundingClientRect();
            if (rect.height <= 900 && rect.width > 20) {
                return sharedParent;
            }
        }

        return mediaElement;
    }

    function collectSampleContextText(labelElement, mediaElement) {
        const lines = [];
        const pushText = (text) => {
            const normalized = normalizeQuestionSectionText(text);
            if (!normalized || lines.includes(normalized)) return;
            lines.push(normalized);
        };

        pushText(labelElement?.textContent);
        getNextVisibleSiblings(labelElement, 4).forEach((element) => {
            if (element === mediaElement || element.contains?.(mediaElement)) return;
            pushText(element.textContent);
        });
        pushText(mediaElement?.textContent);

        return lines.join('\n').slice(0, 320).trim();
    }

    async function collectLabeledMediaParts(questionElement, selector) {
        const mediaParts = [];
        let screenshotCount = 0;
        const seenElements = new Set();
        const labelCandidates = Array.from(questionElement.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, span, strong, label'))
            .filter((element) => isSampleLabelElement(element));

        for (const labelElement of labelCandidates) {
            const mediaElement = resolveSampleCaptureElement(labelElement, questionElement);
            if (!mediaElement) continue;

            const captureElement = resolveSampleCaptureContainer(labelElement, mediaElement, questionElement);
            if (!captureElement || seenElements.has(captureElement)) continue;

            try {
                const mediaLabel = normalizeQuestionSectionText(labelElement.textContent) || '样例区域';
                const mediaContextText = collectSampleContextText(labelElement, mediaElement) || mediaLabel;
                const screenshotDataUrl = await captureElementAsDataUrl(captureElement);
                if (!screenshotDataUrl) continue;

                seenElements.add(captureElement);
                mediaParts.push({
                    type: 'text',
                    text: `下面这张截图对应的区域是“${mediaLabel}”。请优先按这张截图中的表头、列名、别名和结果格式理解这一小节。\n该区域关键信息：\n${mediaContextText}`
                });
                mediaParts.push({
                    type: 'image_url',
                    image_url: { url: screenshotDataUrl }
                });
                screenshotCount += 1;
                appendInputLog(`已提取带标题的样例区域截图：${selector}，标签：${mediaLabel}`);
            } catch (error) {
                appendInputLog(`样例区域截图失败：${selector}，${error.message}`);
            }
        }

        return {
            mediaParts,
            screenshotCount
        };
    }

    function copyComputedStyles(sourceNode, targetNode) {
        if (!(sourceNode instanceof Element) || !(targetNode instanceof Element)) return;

        const computedStyle = window.getComputedStyle(sourceNode);
        let styleText = '';
        for (const propertyName of computedStyle) {
            styleText += `${propertyName}:${computedStyle.getPropertyValue(propertyName)};`;
        }
        targetNode.setAttribute('style', styleText);

        const sourceChildren = Array.from(sourceNode.children);
        const targetChildren = Array.from(targetNode.children);
        for (let i = 0; i < sourceChildren.length; i += 1) {
            copyComputedStyles(sourceChildren[i], targetChildren[i]);
        }
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('图片加载失败'));
            image.src = url;
        });
    }

    async function captureElementAsDataUrl(element) {
        if (!element) return '';

        const rect = element.getBoundingClientRect();
        const width = Math.max(1, Math.ceil(rect.width));
        const height = Math.max(1, Math.ceil(rect.height));
        const cloned = element.cloneNode(true);
        copyComputedStyles(element, cloned);

        const wrapper = document.createElement('div');
        wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        wrapper.style.width = `${width}px`;
        wrapper.style.height = `${height}px`;
        wrapper.style.background = window.getComputedStyle(element).backgroundColor || '#ffffff';
        wrapper.appendChild(cloned);

        const serialized = new XMLSerializer().serializeToString(wrapper);
        const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <foreignObject width="100%" height="100%">${serialized}</foreignObject>
</svg>`;
        const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        const image = await loadImage(svgUrl);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('无法创建截图画布');
        }
        context.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
    }

    async function collectQuestionMediaParts(questionElement, selector, sectionEntries = []) {
        const mediaParts = [];
        let imageCount = 0;
        let screenshotCount = 0;

        const images = getRenderableQuestionImages(questionElement);
        const shouldUseScreenshot = images.length > 0 || elementNeedsScreenshotFallback(questionElement);
        imageCount = images.length;

        const labeledMediaResult = await collectLabeledMediaParts(questionElement, selector);
        if (labeledMediaResult.mediaParts.length > 0) {
            mediaParts.push(...labeledMediaResult.mediaParts);
            screenshotCount += labeledMediaResult.screenshotCount;
        }

        if (shouldUseScreenshot && questionElement && labeledMediaResult.mediaParts.length === 0) {
            try {
                const mediaLabel = inferMediaLabelFromSections(sectionEntries);
                const mediaContextText = buildMediaContextText(sectionEntries, mediaLabel);
                const screenshotDataUrl = await captureElementAsDataUrl(questionElement);
                if (screenshotDataUrl) {
                    mediaParts.push({
                        type: 'text',
                        text: `下面这张题面截图对应的区域是“${mediaLabel}”。请将截图内容与这一小节绑定理解，不要和其它表或样例混淆。\n该区域关键信息：\n${mediaContextText}`
                    });
                    mediaParts.push({
                        type: 'image_url',
                        image_url: { url: screenshotDataUrl }
                    });
                    screenshotCount += 1;
                    appendInputLog(`检测到题面图片/图形内容，已改为区域截图：${selector}，上下文标签：${mediaLabel}`);
                }
            } catch (error) {
                appendInputLog(`题面区域截图失败：${selector}，${error.message}`);
            }
        }

        return {
            mediaParts,
            imageCount,
            screenshotCount
        };
    }

    async function collectQuestionPayload(questionSelectorsList) {
        const orderedEntries = [];
        const mediaParts = [];
        let imageCount = 0;
        let screenshotCount = 0;

        const collectVisibleCodeMirrorFallbackText = () => {
            const visibleEditors = Array.from(document.querySelectorAll('.cm-editor, .cm-content'))
                .filter((element) => isElementVisible(element) && (!panel || !panel.contains(element)));

            const fallbackBlocks = [];
            const seenBlocks = new Set();

            visibleEditors.forEach((editor) => {
                const codeLines = Array.from(editor.querySelectorAll('.cm-line'))
                    .map((line) => line.textContent.replace(/\u00a0/g, ' ').trimEnd())
                    .filter((line) => line.trim().length > 0);

                if (codeLines.length === 0) return;

                const blockText = normalizeQuestionSectionText(codeLines.join('\n'));
                if (!blockText || seenBlocks.has(blockText)) return;

                seenBlocks.add(blockText);
                const { top, left } = getElementVisualPosition(editor);
                fallbackBlocks.push({
                    text: blockText,
                    top,
                    left,
                    index: fallbackBlocks.length
                });
            });

            return fallbackBlocks;
        };

        for (const selector of questionSelectorsList) {
            const questionElement = await waitForElement(selector);
            if (!questionElement) {
                continue;
            }

            const sectionEntries = extractOrderedQuestionSections(questionElement);
            orderedEntries.push(...sectionEntries);

            const mediaResult = await collectQuestionMediaParts(questionElement, selector, sectionEntries);
            mediaParts.push(...mediaResult.mediaParts);
            imageCount += mediaResult.imageCount;
            screenshotCount += mediaResult.screenshotCount;
        }

        const fallbackBlocks = collectVisibleCodeMirrorFallbackText();
        orderedEntries.push(...fallbackBlocks);

        return {
            questionText: mergeOrderedQuestionEntries(orderedEntries),
            mediaParts,
            imageCount,
            screenshotCount,
            fallbackBlockCount: fallbackBlocks.length,
            outputHeaderHints: extractOutputHeaderHints(mergeOrderedQuestionEntries(orderedEntries))
        };
    }

    function buildUserMessageContent(questionPayload, language) {
        const summary = {
            imageCount: questionPayload.imageCount,
            screenshotCount: questionPayload.screenshotCount
        };
        const textPart = {
            type: 'text',
            text: buildUserMultimodalPrompt(questionPayload.questionText, language, summary)
        };

        if (!shouldUseMultimodalPayload() || questionPayload.mediaParts.length === 0) {
            return textPart.text;
        }

        return [textPart, ...questionPayload.mediaParts];
    }

    function isBailianCompatibleApi(url) {
        if (!url) return false;
        return /https:\/\/(?:batch\.)?dashscope(?:-intl|-us)?\.aliyuncs\.com\/compatible-mode\/v1(?:\/chat\/completions)?\/?$/i.test(url.trim());
    }

    function appendInputLog(message) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const line = `[${timestamp}] ${message}`;
        inputLogs.push(line);
        if (inputLogs.length > 200) {
            inputLogs = inputLogs.slice(-200);
        }

        console.log(`[PTA Auto Answer] ${message}`);

        const logElement = document.querySelector('#inputLogText');
        if (!logElement) return;

        logElement.textContent = inputLogs.join('\n');
        if (logElement.scrollHeight > logElement.clientHeight) {
            logElement.scrollTop = logElement.scrollHeight;
        }
    }

    function clearInputLogs() {
        inputLogs = [];
        const logElement = document.querySelector('#inputLogText');
        if (logElement) {
            logElement.textContent = '';
        }
    }

    function collectTextSegments(payload, visited = new WeakSet(), depth = 0) {
        if (payload == null || depth > 8) return [];
        if (typeof payload === 'string') return [payload];
        if (typeof payload === 'number' || typeof payload === 'boolean') return [String(payload)];
        if (Array.isArray(payload)) {
            return payload.flatMap((item) => collectTextSegments(item, visited, depth + 1));
        }
        if (typeof payload !== 'object') return [];
        if (visited.has(payload)) return [];
        visited.add(payload);

        const preferredKeys = [
            'output_text',
            'generated_text',
            'answer',
            'text',
            'value',
            'content',
            'message',
            'messages',
            'delta',
            'output',
            'outputs',
            'response',
            'responses',
            'result',
            'results',
            'data',
            'choices'
        ];

        const segments = [];
        preferredKeys.forEach((key) => {
            if (key in payload) {
                segments.push(...collectTextSegments(payload[key], visited, depth + 1));
            }
        });

        Object.entries(payload).forEach(([key, value]) => {
            if (preferredKeys.includes(key)) return;
            if (/(reasoning|thought|usage|token|logprobs|finish|index|id|model|created)/i.test(key)) return;
            segments.push(...collectTextSegments(value, visited, depth + 1));
        });

        return segments;
    }

    function extractAnswerFromResponse(result) {
        const candidateGroups = [
            result?.choices?.map((choice) => choice?.message?.content),
            result?.choices?.map((choice) => choice?.message),
            result?.choices?.map((choice) => choice?.delta?.content),
            result?.choices?.map((choice) => choice?.text),
            result?.output_text,
            result?.output,
            result?.response,
            result?.result,
            result?.data
        ];

        for (const candidate of candidateGroups) {
            const text = normalizeAnswerText(collectTextSegments(candidate).join('\n'));
            if (text) return text;
        }

        const fallback = normalizeAnswerText(collectTextSegments(result).join('\n'));
        return fallback;
    }

    function extractJsonObjectText(rawText) {
        if (!rawText) return '';

        const fencedJsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = fencedJsonMatch ? fencedJsonMatch[1].trim() : rawText.trim();

        if (candidate.startsWith('{') && candidate.endsWith('}')) {
            return candidate;
        }

        const firstBrace = candidate.indexOf('{');
        if (firstBrace === -1) return '';

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = firstBrace; i < candidate.length; i += 1) {
            const char = candidate[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{') depth += 1;
            if (char === '}') depth -= 1;

            if (depth === 0) {
                return candidate.slice(firstBrace, i + 1);
            }
        }

        return '';
    }

    function parseStructuredAnswer(rawAnswer) {
        const normalizedRaw = normalizeAnswerText(rawAnswer);
        const jsonText = extractJsonObjectText(normalizedRaw);

        if (jsonText) {
            try {
                const parsed = JSON.parse(jsonText);
                const structuredCode = parsed?.code ?? parsed?.answer ?? parsed?.content ?? parsed?.result;
                if (typeof structuredCode === 'string') {
                    return {
                        raw: normalizedRaw,
                        code: normalizeCodeText(structuredCode)
                    };
                }
            } catch (error) {
                console.warn('AI 返回 JSON 解析失败，将回退为普通文本处理：', error);
            }
        }

        return {
            raw: normalizedRaw,
            code: normalizeCodeText(normalizedRaw)
        };
    }

    function isMonacoInput(element) {
        return !!element?.closest?.('.monaco-editor');
    }

    function isCodeMirrorInput(element) {
        return !!element?.closest?.('.codeEditor_CHvdZ, .cm-editor');
    }

    function setNativeValue(element, value) {
        const prototype = element.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) {
            descriptor.set.call(element, value);
        } else {
            element.value = value;
        }
    }

    function isElementVisible(element) {
        if (!element || !document.body.contains(element)) return false;
        if (panel && panel.contains(element)) return false;

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
    }

    function autoDetectQuestionSelectors() {
        const candidates = [];
        const seen = new Set();

        const registerCandidate = (element, minimumLength = 20, scoreOffset = 0) => {
            if (!isElementVisible(element)) return;

            const text = element.textContent.replace(/\s+/g, ' ').trim();
            if (text.length < minimumLength) return;

            const uniqueKey = getElementSelector(element);
            if (seen.has(uniqueKey)) return;

            seen.add(uniqueKey);
            candidates.push({
                element,
                selector: uniqueKey,
                score: text.length + scoreOffset
            });
        };

        const bodySelectorGroups = [
            '.rendered-markdown',
            '[class*="problem"] .rendered-markdown',
            'main .rendered-markdown',
            'article .rendered-markdown',
            '[class*="problem"] .cm-editor',
            '[class*="problem"] .cm-content',
            '[class*="problem"] .cm-line',
            'main .cm-editor',
            'main .cm-content',
            'main .cm-line',
            'article .cm-editor',
            'article .cm-content',
            'article .cm-line',
            '[class*="problem"] pre',
            '[class*="problem"] code',
            'main pre',
            'main code',
            'article pre',
            'article code'
        ];

        bodySelectorGroups.forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => registerCandidate(element, 20, 0));
        });

        const titleCandidates = [];
        const titleSeen = new Set();
        const titleSelectorGroups = [
            'span.text-darkest.font-bold.text-lg',
            'main span.text-darkest.font-bold.text-lg',
            'article span.text-darkest.font-bold.text-lg',
            '[class*="problem"] span.text-darkest.font-bold.text-lg',
            'main h1',
            'main h2',
            'article h1',
            'article h2'
        ];

        titleSelectorGroups.forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
                if (!isElementVisible(element)) return;

                const text = element.textContent.replace(/\s+/g, ' ').trim();
                if (text.length < 6) return;

                const uniqueKey = getElementSelector(element);
                if (titleSeen.has(uniqueKey)) return;

                titleSeen.add(uniqueKey);
                titleCandidates.push({
                    selector: uniqueKey,
                    score: text.length + 1000
                });
            });
        });

        candidates.sort((a, b) => b.score - a.score);
        titleCandidates.sort((a, b) => b.score - a.score);

        return [
            ...titleCandidates.slice(0, 1).map((item) => item.selector),
            ...candidates.slice(0, 3).map((item) => item.selector)
        ].filter((selector, index, array) => array.indexOf(selector) === index);
    }

    function applyAutoDetectedQuestions() {
        const selectors = autoDetectQuestionSelectors();
        const status = document.querySelector('#status');

        if (!selectors.length) {
            status.textContent = '自动提取失败：未找到可见的题目区域，请继续使用手动选择。';
            return false;
        }

        questionSelectors = selectors;
        GM_setValue('questionSelectors', JSON.stringify(questionSelectors));
        status.textContent = `已自动提取题目区域（${questionSelectors.length}个）`;
        updateMergedQuestionText();
        return true;
    }

    function autoDetectInputSelector() {
        const candidates = [
            '.codeEditor_CHvdZ .cm-content[contenteditable="true"]',
            '.cm-editor .cm-content[contenteditable="true"]',
            '[contenteditable="true"]',
            '.monaco-editor textarea',
            'textarea',
            'input[type="text"]',
            '.cm-content[contenteditable="true"]',
            '.CodeMirror textarea',
            '[class*="editor"] textarea',
            '[class*="editor"] [contenteditable="true"]'
        ];

        for (const selector of candidates) {
            const elements = Array.from(document.querySelectorAll(selector));
            const matched = elements.find((element) => {
                if (!isElementVisible(element)) return false;

                const placeholder = (element.getAttribute('placeholder') || '').toLowerCase();
                const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
                const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';

                if (panel && panel.contains(element)) return false;
                if (placeholder.includes('api') || placeholder.includes('密钥')) return false;
                if (ariaLabel.includes('search')) return false;
                if (className.includes('search')) return false;

                return true;
            });

            if (matched) {
                return getElementSelector(matched);
            }
        }

        return null;
    }

    function selectContentEditableEnd(element) {
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function selectContentEditableAll(element) {
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function resolveEditableTarget(element) {
        if (!element) return null;

        if (element.matches?.('textarea, input, [contenteditable="true"]')) {
            return element;
        }

        const nestedEditable = element.querySelector?.(
            '.cm-content[contenteditable="true"], textarea, input, [contenteditable="true"]'
        );

        if (nestedEditable) {
            return nestedEditable;
        }

        if (element.closest?.('.cm-editor')) {
            return element.closest('.cm-editor')?.querySelector('.cm-content[contenteditable="true"]') || element;
        }

        return element;
    }

    function getKeyboardMeta(key) {
        if (key === '\n') {
            return { key: 'Enter', code: 'Enter', keyCode: 13, inputType: 'insertLineBreak', data: null };
        }
        if (key === '\t') {
            return { key: 'Tab', code: 'Tab', keyCode: 9, inputType: 'insertText', data: '\t' };
        }

        const upper = key.toUpperCase();
        const isLetter = /^[a-z]$/i.test(key);
        const isDigit = /^\d$/.test(key);
        return {
            key,
            code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : '',
            keyCode: key.charCodeAt(0),
            inputType: 'insertText',
            data: key
        };
    }

    function applyAutoDetectedInput() {
        const status = document.querySelector('#status');
        const selector = autoDetectInputSelector();

        if (!selector) {
            status.textContent = '自动识别输入框失败：请继续手动选择输入框。';
            return false;
        }

        inputSelector = selector;
        GM_setValue('inputSelector', inputSelector);
        status.textContent = `已自动识别输入框：${inputSelector}`;
        return true;
    }

    function injectPanelStyles() {
        if (document.querySelector('#pta-auto-answer-style')) return;

        const style = document.createElement('style');
        style.id = 'pta-auto-answer-style';
        style.textContent = `
            .pta-panel {
                position: fixed;
                width: min(620px, calc(100vw - 24px));
                height: min(760px, calc(100vh - 24px));
                max-height: calc(100vh - 24px);
                padding: 0;
                background:
                    linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.96));
                border: 1px solid rgba(148, 163, 184, 0.24);
                border-radius: 18px;
                box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
                backdrop-filter: blur(14px);
                z-index: 9999;
                font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                color: #0f172a;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            .pta-panel * {
                box-sizing: border-box;
            }
            .pta-panel__header {
                cursor: move;
                padding: 16px 18px 14px;
                background:
                    radial-gradient(circle at top left, rgba(59, 130, 246, 0.16), transparent 42%),
                    linear-gradient(135deg, #eff6ff, #f8fafc 58%, #ffffff);
                border-bottom: 1px solid rgba(226, 232, 240, 0.9);
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 12px;
            }
            .pta-panel__title {
                margin: 0;
                font-size: 15px;
                font-weight: 700;
                color: #0f172a;
            }
            .pta-panel__subtitle {
                margin: 4px 0 0;
                font-size: 12px;
                color: #475569;
            }
            .pta-panel__body {
                padding: 16px 18px 18px;
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                min-height: 0;
            }
            .pta-section {
                margin-bottom: 14px;
                padding: 14px;
                background: rgba(255,255,255,0.72);
                border: 1px solid rgba(226, 232, 240, 0.9);
                border-radius: 14px;
            }
            .pta-section.is-collapsed .pta-section__content {
                display: none;
            }
            .pta-section__title {
                margin: 0 0 10px;
                font-size: 13px;
                font-weight: 700;
                color: #1e293b;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .pta-field {
                margin-bottom: 10px;
            }
            .pta-field:last-child {
                margin-bottom: 0;
            }
            .pta-label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #64748b;
            }
            .pta-input,
            .pta-select {
                width: 100%;
                padding: 9px 11px;
                border: 1px solid #cbd5e1;
                border-radius: 10px;
                background: #fff;
                font-size: 12px;
                color: #0f172a;
                outline: none;
                transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
            }
            .pta-input:focus,
            .pta-select:focus {
                border-color: #60a5fa;
                box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.16);
            }
            .pta-button-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 8px;
            }
            .pta-button,
            .pta-button--primary,
            .pta-button--accent {
                padding: 9px 10px;
                border-radius: 11px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease, border-color 0.16s ease;
            }
            .pta-button {
                color: #1e293b;
                background: #f8fafc;
                border: 1px solid #dbe3ee;
            }
            .pta-button--primary {
                color: #fff;
                background: linear-gradient(135deg, #2563eb, #1d4ed8);
                border: none;
                box-shadow: 0 10px 24px rgba(37, 99, 235, 0.22);
            }
            .pta-button--accent {
                color: #1d4ed8;
                background: #eff6ff;
                border: 1px solid #bfdbfe;
            }
            .pta-button--success {
                color: #fff;
                background: linear-gradient(135deg, #2563eb, #1d4ed8);
                border: none;
                box-shadow: 0 10px 24px rgba(37, 99, 235, 0.22);
            }
            .pta-button--warning {
                color: #fff;
                background: linear-gradient(135deg, #f97316, #ef4444 52%, #ec4899);
                border: none;
                box-shadow: 0 10px 24px rgba(239, 68, 68, 0.24);
            }
            .pta-button:hover,
            .pta-button--primary:hover,
            .pta-button--accent:hover,
            .pta-button--success:hover,
            .pta-button--warning:hover {
                transform: translateY(-1px);
            }
            .pta-button--full {
                width: 100%;
            }
            .pta-action-stack {
                display: grid;
                grid-template-columns: 1fr;
                gap: 10px;
            }
            .pta-action-button {
                width: 100%;
                padding: 12px 16px;
                font-size: 14px;
                border-radius: 13px;
            }
            .pta-auto-note {
                margin-bottom: 12px;
                padding: 10px 12px;
                border-radius: 12px;
                background: linear-gradient(135deg, #eff6ff, #f8fafc);
                border: 1px solid #dbeafe;
                color: #334155;
                font-size: 12px;
                line-height: 1.6;
            }
            .pta-status {
                min-height: 42px;
                padding: 10px 12px;
                border-radius: 12px;
                background: linear-gradient(135deg, #fff7ed, #fff1f2);
                border: 1px solid #fed7aa;
                font-size: 12px;
                color: #9a3412;
                line-height: 1.5;
                white-space: pre-wrap;
            }
            .pta-preview {
                max-height: 260px;
                min-height: 180px;
                overflow-y: auto;
                padding: 12px;
                border-radius: 12px;
                background:
                    linear-gradient(180deg, rgba(248,250,252,0.96), rgba(241,245,249,0.96));
                border: 1px solid #e2e8f0;
                color: #0f172a;
                font: 12px/1.55 "Consolas", "Cascadia Code", "Courier New", monospace;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .pta-preview.is-collapsed {
                display: none;
            }
            .pta-mini-button {
                padding: 6px 10px;
                border-radius: 999px;
                border: 1px solid rgba(148, 163, 184, 0.35);
                background: rgba(255,255,255,0.78);
                color: #334155;
                font-size: 12px;
                cursor: pointer;
            }
            .pta-mini-button.is-active {
                background: linear-gradient(135deg, #dbeafe, #eff6ff);
                color: #1d4ed8;
                border-color: rgba(59, 130, 246, 0.35);
            }
            .pta-actions {
                display: flex;
                gap: 8px;
                flex-shrink: 0;
            }
            .pta-mode-switch {
                display: inline-flex;
                padding: 3px;
                border-radius: 999px;
                background: rgba(255,255,255,0.86);
                border: 1px solid rgba(148, 163, 184, 0.28);
                gap: 4px;
            }
            .pta-mode-button {
                padding: 6px 10px;
                border: none;
                border-radius: 999px;
                background: transparent;
                color: #475569;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
            }
            .pta-mode-button.is-active {
                background: linear-gradient(135deg, #2563eb, #1d4ed8);
                color: #fff;
            }
            .pta-view {
                display: none;
            }
            .pta-view.is-active {
                display: block;
            }
            .pta-textarea {
                min-height: 180px;
                resize: vertical;
                font: 12px/1.55 "Consolas", "Cascadia Code", "Courier New", monospace;
            }
            @media (max-width: 640px) {
                .pta-panel {
                    width: calc(100vw - 16px);
                    height: calc(100vh - 16px);
                    max-height: calc(100vh - 16px);
                }
                .pta-button-grid {
                    grid-template-columns: 1fr;
                }
            }
        `;
        document.head.appendChild(style);
    }


function createControlPanel() {
    injectPanelStyles();
    panel = document.createElement('div');
    panel.className = 'pta-panel';
    panel.style.top = `${panelPosition.top ?? 20}px`;
    panel.style.right = `${panelPosition.right ?? 20}px`;
    panel.innerHTML = `
        <div id="dragHandle" class="pta-panel__header">
            <div>
                <div class="pta-panel__title">PTA 自动答题助手</div>
                <div id="panelSubtitle" class="pta-panel__subtitle">自动模式：提取题面、识别输入框并调用模型生成答案</div>
            </div>
            <div class="pta-actions">
                <div class="pta-mode-switch">
                    <button id="switchAutoMode" class="pta-mode-button" type="button">自动模式</button>
                    <button id="switchManualMode" class="pta-mode-button" type="button">手动模式</button>
                </div>
                <button id="togglePreview" class="pta-mini-button" type="button">折叠日志</button>
            </div>
        </div>
        <div class="pta-panel__body">
            <div id="autoModeView" class="pta-view">
                <div id="apiConfigSection" class="pta-section${apiConfigCollapsed ? ' is-collapsed' : ''}">
                    <div class="pta-section__title">
                        <span>API 配置</span>
                        <button id="toggleApiConfig" class="pta-mini-button${apiConfigCollapsed ? '' : ' is-active'}" type="button">${apiConfigCollapsed ? '展开配置' : '折叠配置'}</button>
                    </div>
                    <div class="pta-section__content">
                        <div class="pta-field">
                            <label for="apiUrlInput" class="pta-label">API 地址</label>
                            <input type="text" id="apiUrlInput" class="pta-input" placeholder="输入 API 请求地址" value="${apiUrl}">
                        </div>
                        <div class="pta-field">
                            <label for="apiKeyInput" class="pta-label">API Key</label>
                            <input type="password" id="apiKeyInput" class="pta-input" placeholder="输入 API 密钥" value="${apiKey}">
                        </div>
                        <div class="pta-field">
                            <label for="apiModelInput" class="pta-label">模型名称</label>
                            <input type="text" id="apiModelInput" class="pta-input" placeholder="输入模型名称" value="${apiModel}">
                        </div>
                        <div class="pta-field">
                            <label class="pta-label" for="enableThinkingInput">深度思考（百炼兼容协议）</label>
                            <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#334155;">
                                <input type="checkbox" id="enableThinkingInput" ${enableThinking ? 'checked' : ''}>
                                开启深度思考（未勾选时显式关闭）
                            </label>
                        </div>
                        <div class="pta-field">
                            <label for="languageSelect" class="pta-label">选择编程语言</label>
                            <select id="languageSelect" class="pta-select">
                                <option value="C" ${selectedLanguage === 'C' ? 'selected' : ''}>C</option>
                                <option value="C++" ${selectedLanguage === 'C++' ? 'selected' : ''}>C++</option>
                                <option value="Java" ${selectedLanguage === 'Java' ? 'selected' : ''}>Java</option>
                                <option value="Python" ${selectedLanguage === 'Python' ? 'selected' : ''}>Python</option>
                                <option value="SQL" ${selectedLanguage === 'SQL' ? 'selected' : ''}>SQL</option>
                            </select>
                        </div>
                        <button id="saveApiConfig" class="pta-button--primary pta-button--full" type="button">保存 API 配置</button>
                    </div>
                </div>

                <div class="pta-section">
                    <div class="pta-section__title">区域配置</div>
                    <div class="pta-auto-note">题目区域提取与输入框识别会在开始答题时自动执行，无需手动操作。</div>
                    <div class="pta-action-stack">
                        <button id="startAutoAnswer" class="pta-button--success pta-action-button" type="button">单次答题</button>
                        <button id="toggleFullAutoAnswer" class="pta-button--warning pta-action-button" type="button">全自动答题</button>
                    </div>
                </div>

                <div class="pta-section">
                    <div class="pta-section__title">
                        <span>AI 返回内容</span>
                    </div>
                    <pre id="aiAnswerText" class="pta-preview"></pre>
                </div>
            </div>

            <div id="manualModeView" class="pta-view">
                <div class="pta-section">
                    <div class="pta-section__title">手动模式</div>
                    <div class="pta-button-grid">
                        <button id="refreshQuestionPreview" class="pta-button--accent" type="button">刷新题面内容</button>
                        <button id="manualClearQuestion" class="pta-button" type="button">清空题目区域</button>
                        <button id="copyQuestionPreview" class="pta-button--accent" type="button">复制题面内容</button>
                    </div>
                </div>

                <div class="pta-section">
                    <div class="pta-section__title">
                        <span>粘贴内容</span>
                    </div>
                    <textarea id="manualAnswerInput" class="pta-input pta-textarea" placeholder="把答案代码或 AI 返回的 JSON 粘贴到这里，然后点击“粘贴内容并输入”"></textarea>
                    <button id="manualSimulateInput" class="pta-button--primary pta-button--full" type="button" style="margin-top: 10px;">粘贴内容并输入</button>
                </div>
            </div>

            <div id="status" class="pta-status"></div>

            <div class="pta-section" style="margin-bottom: 0;">
                <div class="pta-section__title">
                    <span>输入过程日志</span>
                </div>
                <pre id="inputLogText" class="pta-preview"></pre>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#saveApiConfig').addEventListener('click', () => {
        apiUrl = document.querySelector('#apiUrlInput').value.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
        apiKey = document.querySelector('#apiKeyInput').value.trim();
        apiModel = document.querySelector('#apiModelInput').value.trim() || 'your-bailian-model-id';
        enableThinking = document.querySelector('#enableThinkingInput').checked;
        selectedLanguage = document.querySelector('#languageSelect').value;
        GM_setValue('apiUrl', apiUrl);
        GM_setValue('apiKey', apiKey);
        GM_setValue('apiModel', apiModel);
        GM_setValue('enableThinking', enableThinking);
        GM_setValue('selectedLanguage', selectedLanguage);
        document.querySelector('#status').textContent = `配置保存成功！模型：${apiModel}，语言：${selectedLanguage}，深度思考：${enableThinking ? '开' : '关'}`;
    });

    panel.querySelector('#startAutoAnswer').addEventListener('click', executeAutoAnswer);
    panel.querySelector('#toggleFullAutoAnswer').addEventListener('click', toggleFullAutoAnswer);
    panel.querySelector('#manualSimulateInput').addEventListener('click', executeManualInput);
    panel.querySelector('#refreshQuestionPreview').addEventListener('click', refreshManualQuestionPreview);
    panel.querySelector('#copyQuestionPreview').addEventListener('click', copyQuestionPreviewText);
    panel.querySelector('#switchAutoMode').addEventListener('click', () => setPanelMode('auto'));
    panel.querySelector('#switchManualMode').addEventListener('click', () => setPanelMode('manual'));
    panel.querySelector('#togglePreview').addEventListener('click', () => {
        const preview = panel.querySelector('#inputLogText');
        const toggleButton = panel.querySelector('#togglePreview');
        const collapsed = preview.classList.toggle('is-collapsed');
        toggleButton.textContent = collapsed ? '展开日志' : '折叠日志';
    });

    panel.querySelector('#toggleApiConfig').addEventListener('click', () => {
        apiConfigCollapsed = !apiConfigCollapsed;
        GM_setValue('apiConfigCollapsed', apiConfigCollapsed);
        const section = panel.querySelector('#apiConfigSection');
        const button = panel.querySelector('#toggleApiConfig');
        section?.classList.toggle('is-collapsed', apiConfigCollapsed);
        button?.classList.toggle('is-active', !apiConfigCollapsed);
        if (button) {
            button.textContent = apiConfigCollapsed ? '展开配置' : '折叠配置';
        }
    });

    const clearQuestionSelection = () => {
        questionSelectors = [];
        GM_setValue('questionSelectors', JSON.stringify(questionSelectors));
        document.querySelector('#status').textContent = '已清空所有题目区域选择器';
        updateMergedQuestionText();
    };
    panel.querySelector('#manualClearQuestion').addEventListener('click', clearQuestionSelection);

    const dragHandle = panel.querySelector('#dragHandle');
    let isDragging = false;
    let initialX, initialY, initialPanelX, initialPanelY;

    dragHandle.addEventListener('mousedown', (e) => {
        isDragging = true;
        initialX = e.clientX;
        initialY = e.clientY;
        initialPanelX = panel.offsetLeft;
        initialPanelY = panel.offsetTop;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const deltaX = e.clientX - initialX;
        const deltaY = e.clientY - initialY;
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
        const nextLeft = Math.min(Math.max(0, initialPanelX + deltaX), maxLeft);
        const nextTop = Math.min(Math.max(0, initialPanelY + deltaY), maxTop);

        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            const viewportWidth = window.innerWidth;
            panelPosition = {
                top: panel.offsetTop,
                right: Math.max(0, viewportWidth - panel.offsetLeft - panel.offsetWidth)
            };
            GM_setValue('panelPosition', JSON.stringify(panelPosition));
        }
        isDragging = false;
    });

    window.addEventListener('resize', () => {
        if (!panel) return;

        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
        const currentLeft = panel.offsetLeft;
        const currentTop = panel.offsetTop;
        const nextLeft = Math.min(currentLeft, maxLeft);
        const nextTop = Math.min(currentTop, maxTop);

        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
        panel.style.right = 'auto';

        panelPosition = {
            top: nextTop,
            right: Math.max(0, window.innerWidth - nextLeft - panel.offsetWidth)
        };
        GM_setValue('panelPosition', JSON.stringify(panelPosition));
    });

    setPanelMode(panelMode);
    updateFullAutoButtonState();
    updateMergedQuestionText();
}

    function setPanelMode(mode) {
        panelMode = mode === 'manual' ? 'manual' : 'auto';
        GM_setValue('panelMode', panelMode);

        if (!panel) return;

        const subtitle = panel.querySelector('#panelSubtitle');
        const autoButton = panel.querySelector('#switchAutoMode');
        const manualButton = panel.querySelector('#switchManualMode');
        const autoView = panel.querySelector('#autoModeView');
        const manualView = panel.querySelector('#manualModeView');

        autoButton?.classList.toggle('is-active', panelMode === 'auto');
        manualButton?.classList.toggle('is-active', panelMode === 'manual');
        autoView?.classList.toggle('is-active', panelMode === 'auto');
        manualView?.classList.toggle('is-active', panelMode === 'manual');

        if (subtitle) {
            subtitle.textContent = panelMode === 'manual'
                ? '手动模式：提取题面，并将你粘贴的内容模拟输入到编辑器'
                : '自动模式：提取题面、识别输入框并调用模型生成答案';
        }

        if (panelMode === 'manual') {
            refreshManualQuestionPreview();
        }
    }

async function updateMergedQuestionText() {
    const orderedEntries = [];

    if (window.questionObservers) {
        window.questionObservers.forEach((observer) => observer.disconnect());
    }
    window.questionObservers = [];

    for (const selector of questionSelectors) {
        const container = await waitForElement(selector);
        if (!container) continue;

        const observer = new MutationObserver((mutations) => {
            if (!mutations.some((m) => m.type === 'characterData' || m.addedNodes.length || m.removedNodes.length)) return;
            updateMergedQuestionText();
        });

        observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: false
        });

        window.questionObservers.push(observer);
        orderedEntries.push(...extractOrderedQuestionSections(container));
    }

    questionSelectors = (await Promise.all(questionSelectors.map(async (selector) => (
        (await waitForElement(selector, 100)) ? selector : null
    )))).filter(Boolean);

    GM_setValue('questionSelectors', JSON.stringify(questionSelectors));
    lastMergedQuestionText = mergeOrderedQuestionEntries(orderedEntries);
    updateQuestionPreview(lastMergedQuestionText);
}

    function updateQuestionPreview(text = '') {
        const previewElement = document.querySelector('#questionPreviewText');
        if (!previewElement) return;

        previewElement.textContent = text.trim();

        if (previewElement.scrollHeight > previewElement.clientHeight) {
            previewElement.scrollTop = 0;
        }
    }

    async function refreshManualQuestionPreview() {
        const status = document.querySelector('#status');

        if (questionSelectors.length === 0) {
            applyAutoDetectedQuestions();
        }

        await updateMergedQuestionText();

        if (lastMergedQuestionText) {
            status.textContent = `手动模式已刷新题面内容，共 ${lastMergedQuestionText.length} 个字符`;
        } else {
            status.textContent = '手动模式未提取到题面内容，请先在页面停留到题面完全加载后重试。';
        }
    }

    async function copyQuestionPreviewText() {
        const status = document.querySelector('#status');
        await refreshManualQuestionPreview();
        const text = (lastMergedQuestionText || '').trim();

        if (!text) {
            status.textContent = '当前没有可复制的题面内容。';
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            appendInputLog(`已复制题面内容，长度 ${text.length}`);
            status.textContent = '题面内容已复制到剪贴板';
        } catch (error) {
            appendInputLog(`复制题面内容失败：${error.message}`);
            status.textContent = `复制失败：${error.message}`;
        }
    }

    function updateAiAnswerPreview(text = '') {
        const previewElement = document.querySelector('#aiAnswerText');
        if (!previewElement) return;

        previewElement.textContent = text.trim();

        if (previewElement.scrollHeight > previewElement.clientHeight) {
            previewElement.scrollTop = 0;
        }
    }

    async function executeManualInput() {
        const status = document.querySelector('#status');
        clearInputLogs();
        appendInputLog('开始执行手动模式输入');

        if (questionSelectors.length === 0) {
            applyAutoDetectedQuestions();
        }
        await updateMergedQuestionText();

        if (!inputSelector) {
            applyAutoDetectedInput();
        }

        if (!inputSelector) {
            status.textContent = '请先识别输入框，再执行手动输入。';
            return;
        }

        const manualInput = document.querySelector('#manualAnswerInput');
        const rawText = manualInput?.value || '';
        if (!rawText.trim()) {
            status.textContent = '请先粘贴要输入的内容。';
            return;
        }

        const parsedAnswer = parseStructuredAnswer(rawText);
        const finalText = parsedAnswer.code || normalizeCodeText(rawText);
        if (!finalText) {
            status.textContent = '粘贴内容为空或无法解析。';
            return;
        }

        appendInputLog(`手动模式已读取粘贴内容，长度 ${finalText.length}`);

        const codeInputElement = resolveEditableTarget(document.querySelector(inputSelector));
        if (!codeInputElement) {
            status.textContent = '无法找到保存的输入框，请重新识别输入框。';
            return;
        }

        await simulateTypingAnswer(codeInputElement, finalText, status);
        appendInputLog('手动模式输入完成');
        status.textContent = '手动内容已填充';
    }


    // 进入选择模式（支持题目区域累加）
    function startSelectMode(type) {
        const status = document.querySelector('#status');
        status.textContent = `请移动鼠标选择${type === 'question' ? '题目内容区域（可多次添加）' : '答案输入框'}，点击确认选择`;
        let currentHighlightElement = null;

        const mouseMoveHandler = (e) => {
            if (panel.contains(e.target)) return;
            if (currentHighlightElement) currentHighlightElement.style.cssText = '';
            currentHighlightElement = e.target;
            currentHighlightElement.style.cssText = `
                background-color: rgba(0, 255, 0, 0.2);
                border: 2px dashed #00ff00;
                cursor: crosshair;
            `;
        };

        const clickHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            currentHighlightElement.style.borderColor = '#ff0000';
            status.textContent = '已选择，正在保存...';

            setTimeout(() => {
                document.removeEventListener('mousemove', mouseMoveHandler);
                currentHighlightElement.style.cssText = '';
                const selector = getElementSelector(e.target);

                if (type === 'question') {
                    if (!questionSelectors.includes(selector)) {
                        questionSelectors.push(selector);
                        GM_setValue('questionSelectors', JSON.stringify(questionSelectors));
                        status.textContent = `题目区域添加成功（共${questionSelectors.length}个）：${selector}`;
                    } else {
                        status.textContent = "该区域已保存，无需重复添加";
                    }
                } else {
                    inputSelector = selector;
                    GM_setValue('inputSelector', selector);
                    status.textContent = `输入框保存成功！选择器：${selector}`;
                }
                document.removeEventListener('click', clickHandler);
            }, 1000);
        };

        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('click', clickHandler);
    }

    // 优化生成元素唯一选择器的函数
   function getElementSelector(el) {
    const path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.nodeName.toLowerCase();

        if (el.id) {
            selector = `#${el.id}`;
            path.unshift(selector);
            break;
        } else {
            const siblings = Array.from(el.parentNode.children);
            const index = siblings.indexOf(el);
            selector += `:nth-child(${index + 1})`;
        }

        path.unshift(selector);
        el = el.parentElement;
    }
    return path.join(' > ');
}

    function dispatchKeyboardEvent(target, type, key, overrides = {}) {
        const meta = getKeyboardMeta(key);
        const event = new KeyboardEvent(type, {
            key: meta.key,
            code: meta.code,
            which: meta.keyCode,
            keyCode: meta.keyCode,
            bubbles: true
            ,cancelable: true
            ,ctrlKey: !!overrides.ctrlKey
            ,metaKey: !!overrides.metaKey
            ,shiftKey: !!overrides.shiftKey
        });
        target.dispatchEvent(event);
    }

    function dispatchBeforeInput(element, meta) {
        element.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: meta.inputType,
            data: meta.data
        }));
    }

    function dispatchInputEvent(element, meta) {
        element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: meta.inputType,
            data: meta.data
        }));
    }

    function dispatchChangeEvent(element) {
        element.dispatchEvent(new Event('change', {
            bubbles: true
        }));
    }

    function prepareAnswerForTyping(text) {
        return normalizeCodeText(text);
    }

    function isRemovableAutoCompletedChar(char) {
        return new Set([')', ']', '}', '\'', '"', '`']).has(char);
    }

    function getEditorText(element) {
        if (!element) return '';

        const codeMirrorView = getCodeMirrorView(element);
        if (codeMirrorView?.state?.doc) {
            return codeMirrorView.state.doc.toString();
        }

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            return element.value ?? '';
        }

        if (element.isContentEditable) {
            return (element.innerText ?? element.textContent ?? '')
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n');
        }

        return (element.innerText ?? element.textContent ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
    }

    function getCharAfterCaret(element) {
        if (!element) return '';

        const codeMirrorView = getCodeMirrorView(element);
        if (codeMirrorView?.state?.doc) {
            const caret = codeMirrorView.state.selection.main.head;
            return codeMirrorView.state.doc.sliceString(caret, caret + 1);
        }

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            const value = element.value ?? '';
            const caret = element.selectionStart ?? 0;
            return value.slice(caret, caret + 1);
        }

        if (!element.isContentEditable) {
            return '';
        }

        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !element.contains(selection.anchorNode)) {
            return '';
        }

        const range = selection.getRangeAt(0).cloneRange();
        range.collapse(true);

        const probeRange = range.cloneRange();
        probeRange.setEndAfter(element.lastChild || element);
        const remainingText = probeRange.toString();

        return remainingText.slice(0, 1);
    }

    function findCodeMirrorViewFromNode(node, visited = new WeakSet(), depth = 0) {
        if (!node || depth > 4 || visited.has(node)) {
            return null;
        }
        visited.add(node);

        if (node?.cmView?.rootView?.view?.dispatch) {
            return node.cmView.rootView.view;
        }
        if (node?.cmView?.view?.dispatch) {
            return node.cmView.view;
        }
        if (node?.view?.dispatch && node?.state?.doc) {
            return node.view;
        }

        if (typeof node.querySelector === 'function') {
            const nestedCandidates = [
                node.querySelector('.cm-content'),
                node.querySelector('.cm-line'),
                node.querySelector('[contenteditable="true"]')
            ].filter(Boolean);

            for (const candidate of nestedCandidates) {
                const nestedView = findCodeMirrorViewFromNode(candidate, visited, depth + 1);
                if (nestedView) return nestedView;
            }
        }

        return findCodeMirrorViewFromNode(node.parentElement, visited, depth + 1);
    }

    function getCodeMirrorView(element) {
        const contentRoot = element?.closest?.('.cm-content');
        const editorRoot = element?.closest?.('.cm-editor');
        const candidates = [
            element,
            contentRoot,
            editorRoot,
            editorRoot?.parentElement,
            editorRoot?.querySelector?.('.cm-content'),
            editorRoot?.querySelector?.('.cm-line')
        ].filter(Boolean);

        for (const node of candidates) {
            const view = findCodeMirrorViewFromNode(node);
            if (view) return view;
        }

        return null;
    }

    function setCaretByTextOffset(element, offset) {
        if (!element) return false;

        const codeMirrorView = getCodeMirrorView(element);
        if (codeMirrorView?.dispatch) {
            const boundedOffset = Math.max(0, Math.min(offset, codeMirrorView.state.doc.length));
            codeMirrorView.focus?.();
            codeMirrorView.dispatch({
                selection: {
                    anchor: boundedOffset,
                    head: boundedOffset
                }
            });
            return true;
        }

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            const boundedOffset = Math.max(0, Math.min(offset, (element.value ?? '').length));
            element.focus();
            element.setSelectionRange?.(boundedOffset, boundedOffset);
            return true;
        }

        if (!element.isContentEditable) {
            return false;
        }

        const selection = window.getSelection();
        if (!selection) return false;

        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let currentOffset = 0;

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const nodeLength = node.textContent.length;

            if (offset <= currentOffset + nodeLength) {
                const range = document.createRange();
                range.setStart(node, Math.max(0, offset - currentOffset));
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                element.focus();
                return true;
            }

            currentOffset += nodeLength;
        }

        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        element.focus();
        return true;
    }

    function selectContentEditableCharAtOffset(element, offset) {
        if (!element?.isContentEditable) {
            return false;
        }

        const selection = window.getSelection();
        if (!selection) return false;

        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let currentOffset = 0;

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const text = node.textContent ?? '';
            const nodeLength = text.length;

            if (offset < currentOffset + nodeLength) {
                const startOffset = Math.max(0, offset - currentOffset);
                const endOffset = Math.min(nodeLength, startOffset + 1);
                if (startOffset === endOffset) {
                    return false;
                }

                const range = document.createRange();
                range.setStart(node, startOffset);
                range.setEnd(node, endOffset);
                selection.removeAllRanges();
                selection.addRange(range);
                element.focus();
                return true;
            }

            currentOffset += nodeLength;
        }

        return false;
    }

    function dispatchDeleteForCodeMirror(element, from, to) {
        const codeMirrorView = getCodeMirrorView(element);
        if (!codeMirrorView?.dispatch) {
            return false;
        }

        const docLength = codeMirrorView.state.doc.length;
        const boundedFrom = Math.max(0, Math.min(from, docLength));
        const boundedTo = Math.max(boundedFrom, Math.min(to, docLength));

        if (boundedFrom === boundedTo) {
            return false;
        }

        const deleteTarget = element?.isContentEditable
            ? element
            : element?.closest?.('.cm-editor')?.querySelector('.cm-content[contenteditable="true"]') || element;

        deleteTarget?.focus?.();
        dispatchKeyboardEvent(deleteTarget, 'keydown', 'Delete');

        codeMirrorView.focus?.();
        codeMirrorView.dispatch({
            selection: {
                anchor: boundedFrom,
                head: boundedTo
            },
            changes: {
                from: boundedFrom,
                to: boundedTo,
                insert: ''
            }
        });

        dispatchKeyboardEvent(deleteTarget, 'keyup', 'Delete');
        appendInputLog(`删除自动补全字符，范围 [${boundedFrom}, ${boundedTo})`);
        return true;
    }

    function deleteCharAtTextOffset(element, offset) {
        if (!element) return false;

        const currentText = getEditorText(element);
        const currentChar = currentText.charAt(offset);
        if (!isRemovableAutoCompletedChar(currentChar)) {
            appendInputLog(`跳过偏移 ${offset}，当前位置已不是可删除补全字符：${JSON.stringify(currentChar)}`);
            return false;
        }

        if (dispatchDeleteForCodeMirror(element, offset, offset + 1)) {
            return true;
        }

        const beforeText = currentText;

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            if (!setCaretByTextOffset(element, offset + 1)) {
                return false;
            }

            dispatchKeyboardEvent(element, 'keydown', '\b');
            dispatchBeforeInput(element, {
                inputType: 'deleteContentBackward',
                data: null
            });

            const value = element.value ?? '';
            const caret = element.selectionStart ?? 0;
            const deleteIndex = Math.max(0, caret - 1);
            const nextValue = value.slice(0, deleteIndex) + value.slice(caret);
            setNativeValue(element, nextValue);
            element.setSelectionRange?.(deleteIndex, deleteIndex);

            dispatchInputEvent(element, {
                inputType: 'deleteContentBackward',
                data: null
            });
            dispatchKeyboardEvent(element, 'keyup', '\b');

            const afterText = getEditorText(element);
            appendInputLog(`倒查删除偏移 ${offset}：${JSON.stringify(beforeText.slice(Math.max(0, offset - 2), offset + 3))} -> ${JSON.stringify(afterText.slice(Math.max(0, offset - 2), offset + 2))}`);
            return beforeText !== afterText;
        }

        if (element.isContentEditable) {
            if (selectContentEditableCharAtOffset(element, offset)) {
                dispatchKeyboardEvent(element, 'keydown', 'Delete');
                dispatchBeforeInput(element, {
                    inputType: 'deleteContentForward',
                    data: null
                });

                const deleted = document.execCommand('delete', false);
                if (!deleted) {
                    const selection = window.getSelection();
                    if (selection?.rangeCount) {
                        selection.getRangeAt(0).deleteContents();
                    }
                }

                dispatchInputEvent(element, {
                    inputType: 'deleteContentForward',
                    data: null
                });
                dispatchKeyboardEvent(element, 'keyup', 'Delete');

                const afterText = getEditorText(element);
                appendInputLog(`倒查删除偏移 ${offset}：${JSON.stringify(beforeText.slice(Math.max(0, offset - 2), offset + 3))} -> ${JSON.stringify(afterText.slice(Math.max(0, offset - 2), offset + 2))}`);
                return beforeText !== afterText;
            }
        }

        if (!setCaretByTextOffset(element, offset)) {
            return false;
        }

        deleteCharAfterCaret(element);
        const afterText = getEditorText(element);
        appendInputLog(`倒查删除偏移 ${offset}：${JSON.stringify(beforeText.slice(Math.max(0, offset - 2), offset + 3))} -> ${JSON.stringify(afterText.slice(Math.max(0, offset - 2), offset + 2))}`);
        return beforeText !== afterText;
    }

    function moveCaretRight(element) {
        if (!element) return;

        dispatchKeyboardEvent(element, 'keydown', 'ArrowRight');
        dispatchKeyboardEvent(element, 'keyup', 'ArrowRight');

        const codeMirrorView = getCodeMirrorView(element);
        if (codeMirrorView?.dispatch) {
            const caret = codeMirrorView.state.selection.main.head;
            const nextCaret = Math.min(codeMirrorView.state.doc.length, caret + 1);
            codeMirrorView.focus?.();
            codeMirrorView.dispatch({
                selection: {
                    anchor: nextCaret,
                    head: nextCaret
                }
            });
            appendInputLog(`检测到已有自动补全闭合符，光标右移到 ${nextCaret}`);
            return;
        }

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            const caret = element.selectionStart ?? 0;
            const nextCaret = Math.min((element.value ?? '').length, caret + 1);
            element.setSelectionRange?.(nextCaret, nextCaret);
            return;
        }

        if (!element.isContentEditable) return;

        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !element.contains(selection.anchorNode)) {
            return;
        }

        const range = selection.getRangeAt(0);
        range.setStart(range.endContainer, Math.min(
            range.endOffset + 1,
            range.endContainer.nodeType === Node.TEXT_NODE
                ? range.endContainer.textContent.length
                : range.endContainer.childNodes.length
        ));
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function deleteCharAfterCaret(element) {
        if (!element) return;

        const codeMirrorView = getCodeMirrorView(element);
        if (codeMirrorView?.dispatch) {
            const caret = codeMirrorView.state.selection.main.head;
            dispatchDeleteForCodeMirror(element, caret, caret + 1);
            return;
        }

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            const value = element.value ?? '';
            const caret = element.selectionStart ?? 0;
            const nextCaret = Math.min(value.length, caret + 1);
            element.focus();
            element.setSelectionRange?.(caret, nextCaret);

            dispatchKeyboardEvent(element, 'keydown', 'Delete');
            dispatchBeforeInput(element, {
                inputType: 'deleteContentForward',
                data: null
            });

            const nextValue = value.slice(0, caret) + value.slice(nextCaret);
            setNativeValue(element, nextValue);
            element.setSelectionRange?.(caret, caret);
            dispatchInputEvent(element, {
                inputType: 'deleteContentForward',
                data: null
            });
            dispatchKeyboardEvent(element, 'keyup', 'Delete');
            return;
        }

        if (element.isContentEditable) {
            const selection = window.getSelection();
            if (selection && selection.rangeCount) {
                const range = selection.getRangeAt(0).cloneRange();
                range.collapse(true);

                let deleteRange = null;

                if (range.endContainer.nodeType === Node.TEXT_NODE) {
                    const textNode = range.endContainer;
                    if (range.endOffset < textNode.textContent.length) {
                        deleteRange = document.createRange();
                        deleteRange.setStart(textNode, range.endOffset);
                        deleteRange.setEnd(textNode, range.endOffset + 1);
                    }
                } else if (range.endContainer.childNodes[range.endOffset]) {
                    const nextNode = range.endContainer.childNodes[range.endOffset];
                    deleteRange = document.createRange();
                    deleteRange.selectNode(nextNode);
                }

                if (deleteRange) {
                    selection.removeAllRanges();
                    selection.addRange(deleteRange);
                    element.focus();

                    dispatchKeyboardEvent(element, 'keydown', 'Delete');
                    dispatchBeforeInput(element, {
                        inputType: 'deleteContentForward',
                        data: null
                    });

                    const deleted = document.execCommand('delete', false);
                    if (!deleted) {
                        deleteRange.deleteContents();
                    }

                    const collapsedRange = document.createRange();
                    collapsedRange.setStart(deleteRange.startContainer, deleteRange.startOffset);
                    collapsedRange.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(collapsedRange);

                    dispatchInputEvent(element, {
                        inputType: 'deleteContentForward',
                        data: null
                    });
                    dispatchKeyboardEvent(element, 'keyup', 'Delete');
                    return;
                }
            }
        }

        dispatchKeyboardEvent(element, 'keyup', 'Delete');
    }

    function dispatchInsertForCodeMirror(element, char) {
        const codeMirrorView = getCodeMirrorView(element);
        if (!codeMirrorView?.dispatch) {
            return false;
        }

        const selection = codeMirrorView.state.selection.main;
        const from = Math.max(0, Math.min(selection.from, codeMirrorView.state.doc.length));
        const to = Math.max(from, Math.min(selection.to, codeMirrorView.state.doc.length));
        const nextCaret = from + char.length;

        element.focus?.();

        codeMirrorView.focus?.();
        codeMirrorView.dispatch({
            selection: {
                anchor: from,
                head: to
            },
            changes: {
                from,
                to,
                insert: char
            }
        });
        codeMirrorView.dispatch({
            selection: {
                anchor: nextCaret,
                head: nextCaret
            }
        });

        appendInputLog(`写入字符 ${JSON.stringify(char)} 到 CodeMirror，位置 ${from}`);
        return true;
    }

    function shouldSkipClosingPairWithArrowRight(element, char) {
        return false;
    }

    function reconcileAutoCompletedSuffix(element, expectedText, nextExpectedChar) {
        if (!element || !isCodeMirrorInput(element) || !element.isContentEditable) {
            return;
        }

        const actualText = getEditorText(element);
        if (!actualText.startsWith(expectedText) || actualText.length <= expectedText.length) {
            return;
        }

        const autoCompletedChar = actualText.charAt(expectedText.length);
        const closers = new Set([')', ']', '}', '\'', '"', '`']);

        if (!closers.has(autoCompletedChar)) {
            return;
        }

        const currentCharAfterCaret = getCharAfterCaret(element);
        if (currentCharAfterCaret === autoCompletedChar) {
            setCaretByTextOffset(element, expectedText.length);
            appendInputLog(`检测到自动补全字符 ${JSON.stringify(autoCompletedChar)}，将光标保持在其前方`);
            return;
        }

        if (nextExpectedChar && nextExpectedChar === autoCompletedChar) {
            return;
        }

        setCaretByTextOffset(element, expectedText.length);
        appendInputLog(`检测到多余闭合符 ${JSON.stringify(autoCompletedChar)}，尝试将光标校正到 ${expectedText.length}`);
    }

    function findAutoCompletedExtraClosers(actualText, expectedText) {
        const closers = new Set([')', ']', '}', '\'', '"', '`']);
        const removableOffsets = [];
        let expectedIndex = 0;
        let actualIndex = 0;

        while (actualIndex < actualText.length) {
            const actualChar = actualText[actualIndex];
            const expectedChar = expectedText[expectedIndex];

            if (expectedIndex < expectedText.length && actualChar === expectedChar) {
                expectedIndex += 1;
                actualIndex += 1;
                continue;
            }

            if (closers.has(actualChar)) {
                removableOffsets.push(actualIndex);
                actualIndex += 1;
                continue;
            }

            return [];
        }

        return expectedIndex === expectedText.length ? removableOffsets : [];
    }

    function findBackwardRemovableOffsets(actualText, expectedText) {
        const removableChars = new Set([')', ']', '}', '\'', '"', '`']);
        const removableOffsets = [];
        let actualIndex = actualText.length - 1;
        let expectedIndex = expectedText.length - 1;

        while (actualIndex >= 0 && expectedIndex >= 0) {
            const actualChar = actualText[actualIndex];
            const expectedChar = expectedText[expectedIndex];

            if (actualChar === expectedChar) {
                actualIndex -= 1;
                expectedIndex -= 1;
                continue;
            }

            if (removableChars.has(actualChar)) {
                removableOffsets.push(actualIndex);
                actualIndex -= 1;
                continue;
            }

            return [];
        }

        while (actualIndex >= 0 && removableChars.has(actualText[actualIndex])) {
            removableOffsets.push(actualIndex);
            actualIndex -= 1;
        }

        return expectedIndex < 0 ? removableOffsets : [];
    }

    function getMatchingLookaheadLength(actualText, expectedText, actualIndex, expectedIndex, maxLength = 8) {
        let matched = 0;
        while (
            matched < maxLength
            && actualIndex + matched < actualText.length
            && expectedIndex + matched < expectedText.length
            && actualText[actualIndex + matched] === expectedText[expectedIndex + matched]
        ) {
            matched += 1;
        }
        return matched;
    }

    function applyOffsetsToText(text, offsets) {
        const removableSet = new Set(offsets);
        let result = '';

        for (let i = 0; i < text.length; i += 1) {
            if (!removableSet.has(i)) {
                result += text[i];
            }
        }

        return result;
    }

    function findValidatedRemovableOffsets(actualText, expectedText) {
        const removableChars = new Set([')', ']', '}', '\'', '"', '`']);
        const removableOffsets = [];
        let actualIndex = 0;
        let expectedIndex = 0;

        while (actualIndex < actualText.length && expectedIndex < expectedText.length) {
            const actualChar = actualText[actualIndex];
            const expectedChar = expectedText[expectedIndex];

            if (actualChar === expectedChar) {
                actualIndex += 1;
                expectedIndex += 1;
                continue;
            }

            if (removableChars.has(actualChar)) {
                removableOffsets.push(actualIndex);
                actualIndex += 1;
                continue;
            }

            return [];
        }

        while (actualIndex < actualText.length) {
            if (!removableChars.has(actualText[actualIndex])) {
                return [];
            }
            removableOffsets.push(actualIndex);
            actualIndex += 1;
        }

        if (expectedIndex !== expectedText.length) {
            return [];
        }

        return applyOffsetsToText(actualText, removableOffsets) === expectedText
            ? removableOffsets
            : [];
    }

    function findGreedyRemovableOffsets(actualText, expectedText) {
        const removableChars = new Set([')', ']', '}', '\'', '"', '`']);
        const removableOffsets = [];
        let actualIndex = 0;
        let expectedIndex = 0;

        while (actualIndex < actualText.length && expectedIndex < expectedText.length) {
            const actualChar = actualText[actualIndex];
            const expectedChar = expectedText[expectedIndex];

            if (actualChar === expectedChar) {
                actualIndex += 1;
                expectedIndex += 1;
                continue;
            }

            if (removableChars.has(actualChar)) {
                let removableCount = 0;
                let scanIndex = actualIndex;

                while (scanIndex < actualText.length && actualText[scanIndex] === actualChar) {
                    const lookahead = getMatchingLookaheadLength(actualText, expectedText, scanIndex + 1, expectedIndex);
                    const remainingExpected = expectedText.length - expectedIndex;
                    const minLookahead = remainingExpected > 1 ? 2 : 1;

                    if (lookahead >= minLookahead) {
                        removableCount = scanIndex - actualIndex + 1;
                        break;
                    }

                    scanIndex += 1;
                }

                if (removableCount === 0) {
                    return [];
                }

                for (let i = 0; i < removableCount; i += 1) {
                    removableOffsets.push(actualIndex + i);
                }

                actualIndex += removableCount;
                continue;
            }

            return [];
        }

        while (actualIndex < actualText.length) {
            if (!removableChars.has(actualText[actualIndex])) {
                return [];
            }
            removableOffsets.push(actualIndex);
            actualIndex += 1;
        }

        return expectedIndex === expectedText.length ? removableOffsets : [];
    }

    async function reconcileTypedResult(element, expectedText, status) {
        let actualText = getEditorText(element);
        if (actualText === expectedText) {
            appendInputLog('输入完成，校验通过，无需修正');
            return;
        }

        status.textContent = '正在检查并修正自动补全造成的偏差...';
        appendInputLog(`开始校验输入结果，当前长度 ${actualText.length}，期望长度 ${expectedText.length}`);
        const removableOffsets = findAutoCompletedExtraClosers(actualText, expectedText);
        let repaired = false;

        for (let i = removableOffsets.length - 1; i >= 0; i -= 1) {
            deleteCharAtTextOffset(element, removableOffsets[i]);
            await sleep(18);
            repaired = true;
        }

        actualText = getEditorText(element);
        if (actualText !== expectedText) {
            const validatedRemovableOffsets = findValidatedRemovableOffsets(actualText, expectedText);
            if (validatedRemovableOffsets.length > 0) {
                appendInputLog(`开始校验式删除冗余补全字符，共 ${validatedRemovableOffsets.length} 处`);

                for (let i = validatedRemovableOffsets.length - 1; i >= 0; i -= 1) {
                    const offset = validatedRemovableOffsets[i];
                    const deleted = deleteCharAtTextOffset(element, offset);
                    await sleep(18);
                    repaired = repaired || deleted;
                }

                actualText = getEditorText(element);
            } else {
                appendInputLog('校验式补全删除未命中可安全修正的字符');
            }
        }

        if (actualText !== expectedText) {
            const greedyRemovableOffsets = findGreedyRemovableOffsets(actualText, expectedText);
            if (greedyRemovableOffsets.length > 0) {
                appendInputLog(`开始贪心删除冗余补全字符，共 ${greedyRemovableOffsets.length} 处`);

                for (let i = greedyRemovableOffsets.length - 1; i >= 0; i -= 1) {
                    const offset = greedyRemovableOffsets[i];
                    const deleted = deleteCharAtTextOffset(element, offset);
                    await sleep(18);
                    repaired = repaired || deleted;
                }

                actualText = getEditorText(element);
            } else {
                appendInputLog('贪心补全删除未命中可安全修正的字符');
            }
        }

        if (actualText !== expectedText) {
            const backwardRemovableOffsets = findBackwardRemovableOffsets(actualText, expectedText);
            if (backwardRemovableOffsets.length > 0) {
                appendInputLog(`开始倒查删除多余自动补全字符，共 ${backwardRemovableOffsets.length} 处`);

                for (const offset of backwardRemovableOffsets) {
                    const deleted = deleteCharAtTextOffset(element, offset);
                    await sleep(18);
                    repaired = repaired || deleted;
                }

                actualText = getEditorText(element);
            } else {
                appendInputLog('倒查补全删除未命中可安全修正的字符');
            }
        }

        if (actualText !== expectedText) {
            appendInputLog(`校验失败，当前内容与目标仍不一致。当前长度 ${actualText.length}`);
            appendInputLog(`期望内容：${JSON.stringify(expectedText)}`);
            appendInputLog(`实际内容：${JSON.stringify(actualText)}`);
            throw new Error(`输入校验后仍与目标答案不一致。当前内容：${actualText}`);
        }

        if (repaired) {
            appendInputLog('自动补全倒查修正完成，当前内容已与目标一致');
            status.textContent = `答案已修正并输入：${expectedText.substring(0, 50)}...`;
        }
    }

    function shouldSkipSyntheticKeyboardForChar(element, char) {
        if (!element) return false;
        if (element.isContentEditable) {
            return char.length === 1 || char === '\n' || char === '\t';
        }
        if (!isCodeMirrorInput(element)) return false;

        return char.length === 1 || char === '\n' || char === '\t';
    }

    function insertIntoInputLike(element, char) {
        const meta = getKeyboardMeta(char);
        if (isMonacoInput(element)) {
            element.focus();
            dispatchBeforeInput(element, meta);
            setNativeValue(element, char);
            dispatchInputEvent(element, meta);
            setNativeValue(element, '');
            return;
        }

        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        const value = element.value ?? '';
        const nextValue = value.slice(0, start) + char + value.slice(end);

        element.focus();
        dispatchBeforeInput(element, meta);
        setNativeValue(element, nextValue);
        const nextCursor = start + char.length;
        if (typeof element.setSelectionRange === 'function') {
            element.setSelectionRange(nextCursor, nextCursor);
        }
        dispatchInputEvent(element, meta);
    }

    function insertIntoContentEditable(element, char) {
        const meta = getKeyboardMeta(char);
        element.focus();

        const selection = window.getSelection();
        if (!selection) return;

        if (!selection.rangeCount || !element.contains(selection.anchorNode)) {
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        const range = selection.getRangeAt(0);
        range.deleteContents();

        if (char === '\n') {
            const textNode = document.createTextNode('\n');
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
        } else {
            const textNode = document.createTextNode(char);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(range);
        dispatchInputEvent(element, meta);
    }

    function insertWholeText(element, text) {
        if (!text) return true;

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            element.focus();
            dispatchBeforeInput(element, {
                inputType: 'insertText',
                data: text
            });
            setNativeValue(element, text);
            if (typeof element.setSelectionRange === 'function') {
                element.setSelectionRange(text.length, text.length);
            }
            dispatchInputEvent(element, {
                inputType: 'insertText',
                data: text
            });
            dispatchChangeEvent(element);
            return true;
        }

        if (!element.isContentEditable) {
            return false;
        }

        element.focus();

        selectContentEditableAll(element);
        dispatchBeforeInput(element, {
            inputType: 'insertFromPaste',
            data: text
        });
        const inserted = document.execCommand('insertText', false, text);
        if (inserted) {
            dispatchInputEvent(element, {
                inputType: 'insertFromPaste',
                data: text
            });
            return true;
        }

        try {
            const selection = window.getSelection();
            if (!selection) return false;

            if (!selection.rangeCount || !element.contains(selection.anchorNode)) {
                const range = document.createRange();
                range.selectNodeContents(element);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
            }

            const range = selection.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(text);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            dispatchInputEvent(element, {
                inputType: 'insertText',
                data: text
            });
            return true;
        } catch (error) {
            console.warn('整段文本插入失败，将回退到逐字输入：', error);
            return false;
        }
    }

    function triggerSelectAll(element) {
        element.focus();
        dispatchKeyboardEvent(element, 'keydown', 'a', {
            ctrlKey: true,
            metaKey: navigator.platform.toUpperCase().includes('MAC')
        });
        dispatchKeyboardEvent(element, 'keyup', 'a', {
            ctrlKey: true,
            metaKey: navigator.platform.toUpperCase().includes('MAC')
        });

        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
            element.select?.();
            return;
        }

        if (element.isContentEditable) {
            selectContentEditableAll(element);
        }
    }

    function triggerDeleteSelection(element) {
        dispatchKeyboardEvent(element, 'keydown', '\b');
        dispatchBeforeInput(element, {
            inputType: 'deleteContentBackward',
            data: null
        });
        dispatchKeyboardEvent(element, 'keyup', '\b');
    }

    function clearInputElement(element) {
        element.focus();
        triggerSelectAll(element);
        triggerDeleteSelection(element);
        const isTextInput = element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';

        if (isMonacoInput(element)) {
            setNativeValue(element, '');
            dispatchInputEvent(element, {
                inputType: 'deleteContentBackward',
                data: null
            });
            return;
        }

        if (isCodeMirrorInput(element)) {
            const codeMirrorView = getCodeMirrorView(element);
            if (codeMirrorView?.dispatch) {
                const docLength = codeMirrorView.state.doc.length;
                codeMirrorView.focus?.();
                codeMirrorView.dispatch({
                    selection: {
                        anchor: 0,
                        head: docLength
                    },
                    changes: {
                        from: 0,
                        to: docLength,
                        insert: ''
                    }
                });
                appendInputLog(`已通过 CodeMirror 事务清空内容，原长度 ${docLength}`);
                return;
            }

            selectContentEditableAll(element);
            const cleared = document.execCommand('delete', false);
            if (cleared) {
                dispatchInputEvent(element, {
                    inputType: 'deleteContentBackward',
                    data: null
                });
                return;
            }
        }

        if (isTextInput) {
            if ((element.value ?? '') === '') {
                dispatchInputEvent(element, {
                    inputType: 'deleteContentBackward',
                    data: null
                });
                return;
            }
            setNativeValue(element, '');
            if (typeof element.setSelectionRange === 'function') {
                element.setSelectionRange(0, 0);
            }
        } else if (element.isContentEditable) {
            element.innerHTML = '';
        } else {
            element.textContent = '';
        }

        dispatchInputEvent(element, {
            inputType: 'deleteContentBackward',
            data: null
        });
    }

    async function typeAnswerCharacter(inputElement, text, index, status) {
        if (index >= text.length) {
            appendInputLog(`字符输入完成，共 ${text.length} 个字符`);
            status.textContent = `答案已输入：${text.substring(0, 50)}...`;
            return;
        }

        const char = text[index];
        const skipSyntheticKeyboard = shouldSkipSyntheticKeyboardForChar(inputElement, char);

        if (!skipSyntheticKeyboard) {
            dispatchKeyboardEvent(inputElement, 'keydown', char);
            dispatchKeyboardEvent(inputElement, 'keypress', char);
        }

        if (inputElement.tagName === 'TEXTAREA' || inputElement.tagName === 'INPUT') {
            insertIntoInputLike(inputElement, char);
        } else if (inputElement.isContentEditable) {
            insertIntoContentEditable(inputElement, char);
        } else {
            inputElement.textContent += char;
            dispatchInputEvent(inputElement, getKeyboardMeta(char));
        }

        if (!skipSyntheticKeyboard) {
            dispatchKeyboardEvent(inputElement, 'keyup', char);
        }

        status.textContent = `正在输入答案：${text.substring(0, index + 1).substring(0, 50)}...`;
        await sleep(isMonacoInput(inputElement) ? 22 : isCodeMirrorInput(inputElement) ? 18 : 10);
        return typeAnswerCharacter(inputElement, text, index + 1, status);
    }

    function verifyTypedResult(element, expectedText, status) {
        const actualText = getEditorText(element);
        if (actualText === expectedText) {
            appendInputLog('输入完成，校验通过，无需修正');
            return;
        }

        appendInputLog(`输入校验失败，当前长度 ${actualText.length}，期望长度 ${expectedText.length}`);
        appendInputLog(`期望内容：${JSON.stringify(expectedText)}`);
        appendInputLog(`实际内容：${JSON.stringify(actualText)}`);
        throw new Error(`输入校验后仍与目标答案不一致。当前内容：${actualText}`);
    }

    async function performTypingAttempt(editableTarget, preparedText, status, attempt) {
        appendInputLog(`开始第 ${attempt} 次输入尝试`);
        editableTarget.focus();
        await sleep(50);
        clearInputElement(editableTarget);
        appendInputLog('已清空输入框内容');
        await sleep(50);
        status.textContent = `正在严格模拟键盘输入答案（第 ${attempt} 次）...`;
        await typeAnswerCharacter(editableTarget, preparedText, 0, status);
        verifyTypedResult(editableTarget, preparedText, status);
    }

    async function simulateTypingAnswer(inputElement, text, status) {
        const editableTarget = resolveEditableTarget(inputElement);
        if (!editableTarget) {
            throw new Error('未找到可编辑输入区域');
        }

        const preparedText = prepareAnswerForTyping(text);

        appendInputLog('--- 开始答案填充阶段 ---');
        appendInputLog(`开始输入答案，目标总长度 ${preparedText.length}`);
        appendInputLog('当前输入模式：原始 DOM 连续输入');

        try {
            await performTypingAttempt(editableTarget, preparedText, status, 1);
        } catch (firstError) {
            appendInputLog(`首次输入校验失败，准备自动重试一次：${firstError.message}`);
            status.textContent = '首次输入校验失败，正在自动重试...';
            await sleep(120);

            try {
                await performTypingAttempt(editableTarget, preparedText, status, 2);
                appendInputLog('第二次输入校验通过，继续后续提交流程');
            } catch (secondError) {
                appendInputLog(`第二次输入校验仍失败：${secondError.message}`);
                throw secondError;
            }
        }
    }

// 修改等待元素加载的函数，增加超时时间
    async function waitForElement(selector, timeout = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const element = document.querySelector(selector);
            if (element) return element;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }

    function isElementInteractable(element) {
        if (!element || !document.body.contains(element)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.pointerEvents !== 'none'
            && !element.disabled
            && rect.width > 0
            && rect.height > 0;
    }

    function getElementActionText(element) {
        return (element?.innerText || element?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function findActionButtonByText(label) {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], [tabindex="0"]'))
            .filter((element) => isElementInteractable(element) && (!panel || !panel.contains(element)));

        return candidates.find((element) => getElementActionText(element).includes(label)) || null;
    }

    function triggerElementClick(element) {
        if (!element) return false;
        element.focus?.();

        if (typeof element.click === 'function') {
            element.click();
            return true;
        }

        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
            element.dispatchEvent(new MouseEvent(eventName, {
                bubbles: true,
                cancelable: true
            }));
        });

        return true;
    }

    async function waitForActionButton(label, timeout = 5000, interval = 150) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const button = findActionButtonByText(label);
            if (button) return button;
            await sleep(interval);
        }
        return null;
    }

    function getCurrentProblemKey() {
        try {
            const url = new URL(window.location.href);
            return url.searchParams.get('problemSetProblemId') || `${url.pathname}${url.search}`;
        } catch (error) {
            return window.location.href;
        }
    }

    async function waitForProblemSwitch(previousKey, timeout = 8000, interval = 200) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const currentKey = getCurrentProblemKey();
            if (currentKey && currentKey !== previousKey) {
                return currentKey;
            }
            await sleep(interval);
        }
        return '';
    }

    function resetAfterProblemSwitch() {
        const target = resolveEditableTarget(document.querySelector(inputSelector));
        if (target) {
            clearInputElement(target);
            appendInputLog('检测到已切换到下一题，已主动清空复用编辑器中的旧答案');
        } else {
            appendInputLog('检测到已切换到下一题，但未能定位编辑器用于清空旧答案');
        }

        updateAiAnswerPreview('');
    }

    async function advanceToNextQuestion(status, reason = '') {
        const previousProblemKey = getCurrentProblemKey();
        const nextButton = await waitForActionButton('下一题', 5000);

        if (!nextButton) {
            appendInputLog(`未找到“下一题”按钮，无法跳过当前题${reason ? `：${reason}` : ''}`);
            status.textContent = '无法跳过当前题：未找到下一题按钮';
            return { advanced: false };
        }

        triggerElementClick(nextButton);
        appendInputLog(`已触发“下一题”按钮${reason ? `，原因：${reason}` : ''}`);

        const nextProblemKey = await waitForProblemSwitch(previousProblemKey, 8000);
        if (nextProblemKey) {
            resetAfterProblemSwitch();
            status.textContent = reason ? `已跳过当前题并切换到下一题：${reason}` : '已切换到下一题';
            return { advanced: true };
        }

        appendInputLog('点击“下一题”后未检测到题目标识变化，跳题失败');
        status.textContent = '已点击下一题，但未确认题目是否切换成功';
        return { advanced: false };
    }

    async function autoSubmitAndAdvance(status, options = {}) {
        const {
            advanceAfterSubmit = true
        } = options;
        appendInputLog('开始自动执行提交、本题确认和下一题流程');

        const submitButton = await waitForActionButton('提交本题', 3000);
        if (!submitButton) {
            appendInputLog('未找到“提交本题”按钮，已跳过自动提交流程');
            return { submitted: false, advanced: false };
        }

        triggerElementClick(submitButton);
        appendInputLog('已触发“提交本题”按钮');
        status.textContent = '已触发提交，本题停留在提交界面...';

        if (!advanceAfterSubmit) {
            appendInputLog('当前为单次自动答题，提交触发后停留在提交界面');
            status.textContent = '已触发提交，当前停留在提交界面';
            return { submitted: true, advanced: false };
        }

        const confirmButton = await waitForActionButton('确认', 5000);
        if (confirmButton) {
            triggerElementClick(confirmButton);
            appendInputLog('已触发“确认”按钮');
        } else {
            appendInputLog('5 秒内未出现“确认”按钮，继续尝试下一题');
        }

        await sleep(500);
        const nextResult = await advanceToNextQuestion(status);
        if (!nextResult.advanced) {
            appendInputLog('未找到“下一题”按钮或未检测到题目切换，自动流程结束在当前题');
            if (status.textContent === '已点击下一题，但未确认题目是否切换成功') {
                return { submitted: true, advanced: false };
            }
            status.textContent = '答案已提交，但未找到下一题按钮';
            return { submitted: true, advanced: false };
        }

        status.textContent = '已自动提交并切换到下一题';
        return { submitted: true, advanced: true };
    }

    async function runAutoAnswerRound(options = {}) {
    const {
        clearLogs = true,
        forceRefreshSelectors = false,
        advanceAfterSubmit = true
    } = options;
    const status = document.querySelector('#status');
    if (clearLogs) {
        clearInputLogs();
    }
    appendInputLog('开始执行自动答题');
    if (forceRefreshSelectors || questionSelectors.length === 0) {
        applyAutoDetectedQuestions();
    }
    if (forceRefreshSelectors || !inputSelector) {
        applyAutoDetectedInput();
    }
    if (questionSelectors.length === 0 || !inputSelector) {
        status.textContent = '请先添加题目区域并选择输入框！';
        return { success: false, advanced: false };
    }
    if (!apiKey) {
        status.textContent = '错误：请先配置API Key！';
        return { success: false, advanced: false };
    }
    if (!apiUrl) {
        status.textContent = '错误：请先配置API地址！';
        return { success: false, advanced: false };
    }

    try {
        // 收集所有题目区域内容
        const missingSelectors = [];
        for (const selector of questionSelectors) {
            const questionElement = await waitForElement(selector);
            if (!questionElement) {
                missingSelectors.push(selector);
            }
        }
        if (missingSelectors.length > 0) {
            status.textContent += `警告：部分题目区域未找到，已跳过 ${missingSelectors.length} 个；`;
        }

        const questionPayload = await collectQuestionPayload(questionSelectors);
        appendInputLog(`题目抓取完成，已合并 ${questionSelectors.length} 个区域`);
        appendInputLog(`题面媒体采集完成：图片 ${questionPayload.imageCount} 张，截图 ${questionPayload.screenshotCount} 张`);
        appendInputLog(`CodeMirror 兜底补充代码块：${questionPayload.fallbackBlockCount || 0} 个`);
        appendInputLog(`最终题面文本预览：\n${(questionPayload.questionText || '').slice(0, 1200) || '[空]'}`);

        if (questionPayload.questionText === '' && questionPayload.mediaParts.length === 0) {
            status.textContent = '所有题目区域均未找到有效内容！';
            return;
        }

        // 调用用户配置的API URL
        status.textContent = '正在调用API获取答案...';
        const userContent = buildUserMessageContent(questionPayload, selectedLanguage);
        const requestBody = {
            messages: [
                { role: "system", content: buildSystemPrompt(selectedLanguage) },
                { role: "user", content: userContent }
            ],
            model: apiModel
        };

        if (isBailianCompatibleApi(apiUrl)) {
            requestBody.enable_thinking = enableThinking;
            appendInputLog(
                enableThinking
                    ? '检测到百炼兼容协议，已显式开启深度思考'
                    : '检测到百炼兼容协议，已显式注入关闭思考参数'
            );
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorBody = await response.json();
            throw new Error(`API请求失败（状态码：${response.status}，错误信息：${errorBody.error?.message || '无详细信息'}）`);
        }

        const result = await response.json();
        const rawAnswer = extractAnswerFromResponse(result);
        if (!rawAnswer) {
            throw new Error(`未能从AI返回结果中提取可用答案：${JSON.stringify(result).slice(0, 300)}`);
        }
        const parsedAnswer = parseStructuredAnswer(rawAnswer);
        if (!parsedAnswer.code) {
            throw new Error('AI 返回内容无法解析出 code 字段，请检查模型输出格式');
        }
        updateAiAnswerPreview(parsedAnswer.code);
        appendInputLog(`AI 答案解析完成，代码长度 ${parsedAnswer.code.length}`);

        // 输入答案
        const codeInputElement = resolveEditableTarget(document.querySelector(inputSelector));
        if (!codeInputElement) {
            status.textContent = '无法找到保存的输入框，请重新选择！';
            return { success: false, advanced: false };
        }

        try {
            await simulateTypingAnswer(codeInputElement, parsedAnswer.code, status);
        } catch (typingError) {
            appendInputLog(`输入两次仍失败，准备跳过当前题：${typingError.message}`);
            status.textContent = '输入两次仍失败，正在跳过当前题...';
            const skipResult = await advanceToNextQuestion(status, '输入校验连续失败');

            if (!skipResult.advanced) {
                appendInputLog('跳过当前题失败，自动流程停止');
                return { success: false, advanced: false };
            }

            appendInputLog('当前题已跳过，继续后续流程');
            return {
                success: true,
                advanced: true
            };
        }

        const submitResult = await autoSubmitAndAdvance(status, {
            advanceAfterSubmit
        });

        appendInputLog('自动答题流程结束');
        if (status.textContent === '正在严格模拟键盘输入答案...' || status.textContent.startsWith('答案已输入')) {
            status.textContent = 'AI答案已填充';
        }
        return {
            success: true,
            advanced: !!submitResult?.advanced
        };

        } catch (error) {
        console.error('自动答题错误:', error);
        appendInputLog(`流程报错：${error.message}`);
        status.textContent = `出错了：${error.message}`;
        return { success: false, advanced: false };
    }
}

    async function executeAutoAnswer() {
        return runAutoAnswerRound({
            clearLogs: true,
            forceRefreshSelectors: false,
            advanceAfterSubmit: false
        });
    }

    function updateFullAutoButtonState() {
        const button = document.querySelector('#toggleFullAutoAnswer');
        if (!button) return;
        button.textContent = isAutoRunning ? '停止全自动答题' : '开启全自动答题';
    }

    async function toggleFullAutoAnswer() {
        const status = document.querySelector('#status');

        if (isAutoRunning) {
            isAutoRunning = false;
            updateFullAutoButtonState();
            appendInputLog('用户已请求停止全自动答题');
            status.textContent = '正在停止全自动答题...';
            return;
        }

        isAutoRunning = true;
        clearInputLogs();
        updateFullAutoButtonState();
        appendInputLog('开始执行全自动答题循环');

        let round = 0;

        while (isAutoRunning) {
            round += 1;
            appendInputLog(`--- 全自动第 ${round} 轮开始 ---`);
            status.textContent = `全自动运行中：第 ${round} 题`;

            const result = await runAutoAnswerRound({
                clearLogs: false,
                forceRefreshSelectors: true,
                advanceAfterSubmit: true
            });

            if (!isAutoRunning) {
                break;
            }

            if (!result.success) {
                appendInputLog(`第 ${round} 轮执行失败，全自动已停止`);
                status.textContent = `全自动已停止：第 ${round} 题执行失败`;
                isAutoRunning = false;
                break;
            }

            if (!result.advanced) {
                appendInputLog(`第 ${round} 轮未能切换到下一题，全自动已停止`);
                status.textContent = `全自动已结束：第 ${round} 题之后无法进入下一题`;
                isAutoRunning = false;
                break;
            }

            await sleep(1200);
        }

        updateFullAutoButtonState();
        if (!isAutoRunning && status.textContent === '正在停止全自动答题...') {
            status.textContent = '全自动答题已停止';
        }
    }



    // 初始化（加载保存的API配置）
    window.addEventListener('load', () => {
        createControlPanel();
        document.querySelector('#apiUrlInput').value = apiUrl;  // 加载保存的API URL
        document.querySelector('#apiKeyInput').value = apiKey;  // 加载保存的API Key
        document.querySelector('#apiModelInput').value = apiModel;
        if (questionSelectors.length > 0 && inputSelector) {
            document.querySelector('#status').textContent = `已加载保存的选择器：题目区域（${questionSelectors.length}个），输入框[${inputSelector}]`;
        } else if (questionSelectors.length > 0) {
            document.querySelector('#status').textContent = `已加载保存的题目区域（${questionSelectors.length}个），请选择输入框`;
        }
    });
})();
