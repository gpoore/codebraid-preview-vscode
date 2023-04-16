// Copyright (c) 2022-2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


const vscode = acquireVsCodeApi();

let editorMinLine = 0;
let editorMaxLine = 0;
let codebraidSourceposMetaElement = document.getElementById('codebraid-sourcepos-meta');
if (codebraidSourceposMetaElement) {
    editorMinLine = Number(codebraidSourceposMetaElement.getAttribute('data-codebraid-sourcepos-min'));
    editorMaxLine = Number(codebraidSourceposMetaElement.getAttribute('data-codebraid-sourcepos-max'));
}
let codebraidSourceposMaxElement = codebraidSourceposMetaElement;


// Start in state that allows editor to sync its scroll location to the
// preview.  Otherwise, as soon as the preview loads, it sends its initial
// scroll location of y=0 to the editor.
let isScrollingPreviewWithEditor = true;
let isScrollingPreviewWithEditorTimer = setTimeout(
    () => {
        isScrollingPreviewWithEditor = false;
        isScrollingPreviewWithEditorTimer = undefined;
    },
    100
);


window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
        case 'codebraidPreview.startingCodebraid': {
            const outputElems = document.querySelectorAll('.codebraid-output');
            for (const elem of outputElems) {
                elem.classList.add('codebraid-output-prepping');
            }
            return;
        }
        case 'codebraidPreview.scrollPreview': {
            if (editorMaxLine === 0) {
                return;
            }
            isScrollingPreviewWithEditor = true;
            scrollPreviewWithEditor(message.startLine);
            if (isScrollingPreviewWithEditorTimer !== undefined) {
                clearTimeout(isScrollingPreviewWithEditorTimer);
            }
            isScrollingPreviewWithEditorTimer = setTimeout(
                () => {
                    isScrollingPreviewWithEditor = false;
                    isScrollingPreviewWithEditorTimer = undefined;
                },
                50
            );
            return;
        }
        case 'codebraidPreview.tempAlert': {
            let alertDiv = document.createElement('div');
            alertDiv.classList.add('codebraid-temp-alert');
            alertDiv.innerHTML = message.tempAlert;
            document.body.appendChild(alertDiv);
            const alertPosElems = alertDiv.getElementsByClassName('codebraid-temp-alert-pos');
            for (const alertPosElem of alertPosElems) {
                alertPosElem.addEventListener(
                    'click',
                    () => {
                        const [lineNumber, lineColumn] = alertPosElem.getAttribute('data-codebraid-temp-alert-pos').split(':').map((s) => Number(s));
                        vscode.postMessage({
                            command: 'codebraidPreview.moveCursor',
                            startLine: lineNumber, // Editor is zero-indexed, but that's handled on editor side.
                            startColumn: lineColumn,
                        });
                    },
                    false
                );
            }
            return;
        }
        case 'codebraidPreview.clearTempAlerts': {
            const elements = document.getElementsByClassName('codebraid-temp-alert');
            for (const element of elements) {
                element.parentNode.removeChild(element);
            }
            return;
        }
    }
});


const baseElement = document.querySelector('base');
let pandocDefaultDataDir = baseElement.getAttribute('data-pandocdefaultdatadir');
let pandocDefaultDataDirAsFileUri = baseElement.getAttribute('data-pandocdefaultdatadirasfileuri');
let pandocDefaultDataDirAsWebviewUri = baseElement.getAttribute('data-pandocdefaultdatadiraswebviewuri');
for (const elem of document.querySelectorAll('[href]')) {
    if (elem.href.startsWith(pandocDefaultDataDir)) {
        elem.href = pandocDefaultDataDirAsWebviewUri + elem.href.slice(pandocDefaultDataDir.length);
    } else if (elem.href.startsWith(pandocDefaultDataDirAsFileUri)) {
        elem.href = pandocDefaultDataDirAsWebviewUri + elem.href.slice(pandocDefaultDataDirAsFileUri.length);
    }
}
for (const elem of document.querySelectorAll('[src]')) {
    if (elem.src.startsWith(pandocDefaultDataDir)) {
        elem.src = pandocDefaultDataDirAsWebviewUri + elem.src.slice(pandocDefaultDataDir.length);
    } else if (elem.src.startsWith(pandocDefaultDataDirAsFileUri)) {
        elem.src = pandocDefaultDataDirAsWebviewUri + elem.src.slice(pandocDefaultDataDirAsFileUri.length);
    }
}


function scrollPreviewWithEditor(startLine) {
    let searchLine = Math.min(startLine, editorMaxLine);
    let element = document.getElementById(`codebraid-sourcepos-${searchLine}`);
    if (element) {
        if (element.hasAttribute('data-codebraid-sourcepos-ref')) {
            element = document.getElementById(element.getAttribute('data-codebraid-sourcepos-ref'));
        }
        window.scrollBy(0, element.getBoundingClientRect().top);
        return;
    }
    while (!element && searchLine > 1) {
        searchLine -= 1;
        element = document.getElementById(`codebraid-sourcepos-${searchLine}`);
    }
    let elementLines = undefined;
    if (element) {
        if (element.hasAttribute('data-codebraid-sourcepos-ref')) {
            element = document.getElementById(element.getAttribute('data-codebraid-sourcepos-ref'));
        }
        if (element.hasAttribute('data-codebraid-sourcepos-lines')) {
            elementLines = Number(element.getAttribute('data-codebraid-sourcepos-lines'));
            if (startLine < searchLine + elementLines) {
                const subElementLine = startLine - searchLine; // Calculate assuming fenced code blocks.
                const subElement = document.getElementById(`codebraid-sourcepos-${searchLine}-${subElementLine}`);
                if (subElement) {
                    window.scrollBy(0, subElement.getBoundingClientRect().top);
                    return;
                }
                const rect = element.getBoundingClientRect();
                const offset = (startLine - searchLine) / elementLines * rect.height;
                window.scrollBy(0, rect.top + offset);
                return;
            }
        }
        if (searchLine === startLine - 1) {
            // This must be after the check for an overlapping element with
            // a lines attribute (code block).
            window.scrollBy(0, element.getBoundingClientRect().bottom);
            return;
        }
    }
    let nextSearchLine = startLine + 1;
    let nextElement = document.getElementById(`codebraid-sourcepos-${nextSearchLine}`);
    if (!nextElement) {
        while (!nextElement && nextSearchLine < editorMaxLine) {
            nextSearchLine += 1;
            nextElement = document.getElementById(`codebraid-sourcepos-${nextSearchLine}`);
        }
        if (!nextElement) {
            nextSearchLine = editorMaxLine;
            nextElement = codebraidSourceposMaxElement;
        } else {
            if (nextElement.hasAttribute('data-codebraid-sourcepos-ref')) {
                nextElement = document.getElementById(nextElement.getAttribute('data-codebraid-sourcepos-ref'));
            }
        }
    }
    if (!element) {
        // Note:  Must use absolute coordinates in this case.
        let ratio = (startLine - 1) / Math.max(nextSearchLine - 1, 1);
        window.scrollTo(0, ratio * (window.scrollY + nextElement.getBoundingClientRect().top));
        return;
    }
    const rect = element.getBoundingClientRect();
    const nextRect = nextElement.getBoundingClientRect();
    let ratio;
    if (elementLines) {
        ratio = (startLine - (searchLine + elementLines)) / Math.max(nextSearchLine - (searchLine + elementLines), 1);
    } else {
        ratio = (startLine - (searchLine + 1)) / Math.max(nextSearchLine - (searchLine + 1), 1);
    }
    window.scrollBy(0, rect.bottom + Math.max(0, ratio * (nextRect.top - rect.bottom)));
}


let visibleElements = new Set();
function webviewVisibleTracker(entries, observer) {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            visibleElements.add(entry.target);
        } else {
            visibleElements.delete(entry.target);
        }
    }
    if (!isScrollingPreviewWithEditor && visibleElements.size !== 0) {
        scrollEditorWithPreview();
    }
}
function scrollEditorWithPreview() {
    let minLine = editorMaxLine + 1;
    let topElement = undefined;
    let topLine = undefined;
    for (const element of visibleElements) {
        let startLine = Number(element.getAttribute('data-codebraid-sourcepos-start'));
        if (startLine < minLine) {
            minLine = startLine;
            topElement = element;
        }
    }
    let elementLines = undefined;
    if (topElement.hasAttribute('data-codebraid-sourcepos-lines')) {
        elementLines = Number(topElement.getAttribute('data-codebraid-sourcepos-lines'));
    }
    const rect = topElement.getBoundingClientRect();
    if (rect.top >= 0 || !elementLines) {
        topLine = minLine;
        if (topLine === editorMinLine) {
            let scrollY = window.scrollY;
            if (scrollY === 0) {
                topLine = 1;
            } else {
                let ratio = scrollY / (scrollY + rect.top);
                topLine = Math.max(Math.floor(ratio * topLine), 1);
            }
        }
    } else {
        topLine = minLine + Math.floor((-rect.top / rect.height) * elementLines);
    }
    if (!topLine) {
        return;
    }
    vscode.postMessage(
        {
            command: 'codebraidPreview.scrollEditor',
            startLine: topLine, // Editor is zero-indexed, but that's handled on editor side.
        }
    );
}
let webviewVisibleObserver = new IntersectionObserver(webviewVisibleTracker, {threshold: [0, 0.25, 0.5, 0.75, 1]});
for (const element of document.querySelectorAll('[data-codebraid-sourcepos-start]')) {
    if (!element.hasAttribute('data-codebraid-sourcepos-lines')) {
        webviewVisibleObserver.observe(element);
        continue;
    }
    let subElementCount = 0;
    let startLine = Number(element.getAttribute('data-codebraid-sourcepos-start'));
    for (let subLine = 1; subLine <= Number(element.getAttribute('data-codebraid-sourcepos-lines')); subLine++) {
        const subElement = document.getElementById(`${element.id}-${subLine}`);
        if (subElement) {
            // Calculate line number assuming fenced code blocks.
            subElement.setAttribute('data-codebraid-sourcepos-start', `${startLine + subLine}`);
            webviewVisibleObserver.observe(subElement);
            subElementCount += 1;
        }
    }
    if (!subElementCount) {
        webviewVisibleObserver.observe(element);
    }
}


// Disable double-click causing selection, so that it can be used for jumping
// to editor location.
document.addEventListener(
    'mousedown',
    (event) => {
        if (event.detail === 2) {
            event.preventDefault();
        }
    },
    false
);
ondblclick = function(event) {
    if (editorMaxLine === 0 || visibleElements.size === 0) {
        return;
    }
    let targetY = event.clientY;
    let minLine = 0;
    let topElement = undefined;
    let topRect = undefined;
    let maxLine = editorMaxLine + 1;
    let bottomElement = undefined;
    let bottomRect = undefined;
    for (const element of visibleElements) {
        const startLine = Number(element.getAttribute('data-codebraid-sourcepos-start'));
        if (startLine < minLine || startLine > maxLine) {
            continue;
        }
        let rect = element.getBoundingClientRect();
        if (rect.top <= targetY) {
            if (rect.bottom < targetY) {
                topElement = element;
                topRect = rect;
                minLine = startLine;
            } else {
                topElement = element;
                topRect = rect;
                minLine = startLine;
                bottomElement = element;
                bottomRect = rect;
                maxLine = startLine;
                break;
            }
        } else {
            bottomElement = element;
            bottomRect = rect;
            maxLine = startLine;
        }
    }
    let targetLine;
    if (topElement === bottomElement) {
        targetLine = minLine;
    } else {
        if (!bottomElement) {
            bottomElement = codebraidSourceposMaxElement;
            bottomRect = codebraidSourceposMaxElement.getBoundingClientRect();
            maxLine = editorMaxLine;
        }
        if (!topElement) {
            const scrollY = window.scrollY;
            const ratio = (scrollY + targetY) / (scrollY + bottomRect.top);
            targetLine = Math.max(Math.floor(ratio * (maxLine - 1)), 1);
        } else {
            const ratio = (targetY - topRect.bottom) / (bottomRect.top - topRect.bottom);
            targetLine = minLine + Math.floor(ratio * (maxLine - minLine - 1));
        }
    }
    vscode.postMessage(
        {
            command: 'codebraidPreview.moveCursor',
            startLine: targetLine,
        }
    );
};
