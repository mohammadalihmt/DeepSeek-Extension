/**
 * sidepanel.js
 * Handles the chat UI, Markdown rendering, MathJax typesetting,
 * file attachment preview, and communication with the background script.
 * Uses a persistent port for reliable streaming data delivery,
 * while one‑off messages (START_STREAMING, DISPLAY_RESULT) arrive via
 * chrome.runtime.onMessage.
 */

// ========== DOM elements ==========
let chatContainer = document.getElementById('chatContainer');
let messageInput = document.getElementById('messageInput');
let sendBtn = document.getElementById('sendBtn');
let settingsBtn = document.getElementById('settingsBtn');
let settingsPanel = document.getElementById('settingsPanel');
let closeSettings = document.getElementById('closeSettings');
let newChatBtn = document.getElementById('newChatBtn');
let attachBtn = document.getElementById('attachBtn');
let fileInput = document.getElementById('fileInput');

// Attachment preview bar elements (inside the input area)
let attachmentPreview = document.getElementById('attachmentPreview');
let attachmentFileName = document.getElementById('attachmentFileName');
let removeAttachmentBtn = document.getElementById('removeAttachmentBtn');

// ========== State ==========
let currentStreamHandler = null;          // currently active stream helper
let selectedFile = null;                  // { base64, mimeType, name } for attached file

// ========== Persistent port for streaming data (with automatic retry) ==========
let streamPort = null;
let portReady = false;
let retryTimer = null;

/**
 * Attempt to establish a persistent connection to the background service worker.
 * On failure, retries automatically every 1 second.
 */
function tryConnect() {
    // Clear any pending retry
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    // Attempt to open the port – this will wake the worker
    try {
        streamPort = chrome.runtime.connect({ name: 'sidepanel-stream' });
    } catch (e) {
        console.warn('[SidePanel] Port connection failed, retrying in 1s…');
        retryTimer = setTimeout(tryConnect, 1000);
        return;
    }

    console.log('[SidePanel] Stream port connecting…');

    // Heartbeat – keep the service worker alive with periodic pings
    const heartbeat = setInterval(() => {
        if (streamPort) {
            try { streamPort.postMessage({ type: 'ping' }); } catch (e) {}
        } else {
            clearInterval(heartbeat);
        }
    }, 5000);  // every 5 seconds
    streamPort._heartbeat = heartbeat;  // store for cleanup on disconnect

    // Listen for messages from the background script
    streamPort.onMessage.addListener((msg) => {
        // Handshake reply – port is now fully ready for use
        if (msg.type === 'pong') {
            if (!portReady) {
                portReady = true;
                console.log('[SidePanel] Stream port ready (pong received)');
            }
            return;
        }
        // Streaming data from the server
        if (msg.type === "STREAMING_DATA") {
            if (!currentStreamHandler) {
                console.warn('[SidePanel] STREAMING_DATA but no handler – data lost:', msg.data.type, msg.data.content?.length);
                return;
            }
            const d = msg.data;
            console.log(`[SidePanel] STREAMING_DATA type=${d.type} content-length=${d.content?.length || 0}`);
            if (d.type === 'thinking') currentStreamHandler.addThinking(d.content);
            else if (d.type === 'response') currentStreamHandler.addResponse(d.content);
            else if (d.type === 'done') currentStreamHandler.finalize();
            else if (d.type === 'error') currentStreamHandler.error(d.content);
            else if (d.type === 'conversation_id') updateConversationId(d.content);
        }
    });

    // Auto‑reconnect if the port is lost (e.g., worker restarts)
    streamPort.onDisconnect.addListener(() => {
        console.warn('[SidePanel] Stream port disconnected – reconnecting in 1s');
        if (streamPort && streamPort._heartbeat) clearInterval(streamPort._heartbeat);
        streamPort = null;
        portReady = false;
        retryTimer = setTimeout(tryConnect, 1000);
    });

    // Send an immediate ping to complete the handshake
    setTimeout(() => {
        if (streamPort) {
            try { streamPort.postMessage({ type: 'ping' }); } catch (e) {}
        }
    }, 100);
}

// Start the first connection attempt
tryConnect();


// ========== One‑off messages from background ==========
/**
 * Listens for messages that don't belong to the persistent streaming port,
 * such as START_STREAMING (from context menus or omnibox) and DISPLAY_RESULT
 * (from page analysis).
 */
chrome.runtime.onMessage.addListener((request) => {
    console.log('[SidePanel] Message received:', request.type);

    if (request.type === "START_STREAMING") {
        const options = {};
        if (request.noAutoApiCall) options.noAutoApiCall = true;
        let userMessage = request.userMessage;
        if (request.image) userMessage = '📷 ' + userMessage;
        if (request.conversationId) updateConversationId(request.conversationId);
        startStreaming(userMessage, request.actionTitle, request.prompt, request.systemPrompt, options);
    } else if (request.type === "DISPLAY_RESULT") {
        addUserMessage(request.prompt || "Analysis");
        addAssistantMessage(request.result);
    }
});

// ========== Conversation ID management ==========
let conversationId = null;                 // persistent ID stored in chrome.storage.session & localStorage

/**
 * Initialise the conversation ID.
 * Tries chrome.storage.session first, then localStorage,
 * and falls back to a new random UUID if neither exists.
 */
async function initConversationId() {
    const stored = await chrome.storage.session.get('conversationId');
    if (stored.conversationId) {
        conversationId = stored.conversationId;
        localStorage.setItem('deepseek_conversation_id', conversationId);
        console.log('[SidePanel] Loaded conversationId from storage:', conversationId);
    } else {
        conversationId = localStorage.getItem('deepseek_conversation_id');
        if (!conversationId) {
            conversationId = crypto.randomUUID ? crypto.randomUUID() : 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
            localStorage.setItem('deepseek_conversation_id', conversationId);
            console.log('[SidePanel] Created new conversationId:', conversationId);
        }
        await chrome.storage.session.set({ conversationId });
    }
}

/**
 * Update the conversation ID and persist to both storages.
 * Called when the server sends a new conversation_id (e.g., after first message).
 */
async function updateConversationId(newId) {
    if (newId && newId !== conversationId) {
        conversationId = newId;
        localStorage.setItem('deepseek_conversation_id', newId);
        await chrome.storage.session.set({ conversationId: newId });
        console.log('[SidePanel] Updated conversationId to:', newId);
    }
}

// ========== Persian (RTL) detection ==========
/**
 * Returns true if the text contains any Persian/Arabic Unicode characters.
 * Used to auto‑apply RTL direction classes.
 */
function containsPersian(text) {
    const persianRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
    return persianRegex.test(text);
}

// ========== Enhanced Markdown → HTML converter ==========
/**
 * Converts a subset of Markdown (headings, tables, bold, italic, strikethrough,
 * inline code, fenced code blocks) into HTML safe for innerHTML.
 * Does NOT process LaTeX – MathJax handles that separately.
 */
function renderMarkdown(text) {
    if (!text) return '';

    // Escape the three main HTML special characters
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Headings (must be processed before bold/italic to avoid conflicts with ** and __)
    html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Tables – finds consecutive lines that start with '|'
    html = html.replace(/((?:^[|][^\n]*[|]\s*$\n?)+)/gm, (match) => {
        const lines = match.trim().split('\n');
        if (lines.length < 2) return match; // a valid table needs at least a header and a separator row
        let tableHtml = '<table>';
        let headerProcessed = false;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            // Remove leading/trailing pipe
            if (line.startsWith('|')) line = line.substring(1);
            if (line.endsWith('|')) line = line.substring(0, line.length - 1);
            const cells = line.split('|').map(c => c.trim());
            // Detect separator line (e.g. :---, :---: ) and skip it
            if (/^[-: ]+$/.test(line.replace(/:/g, '')) && i === 1) continue;
            if (!headerProcessed) {
                tableHtml += '<thead><tr>';
                cells.forEach(c => tableHtml += `<th>${c}</th>`);
                tableHtml += '</tr></thead><tbody>';
                headerProcessed = true;
            } else {
                tableHtml += '<tr>';
                cells.forEach(c => tableHtml += `<td>${c}</td>`);
                tableHtml += '</tr>';
            }
        }
        tableHtml += '</tbody></table>';
        return tableHtml;
    });

    // Bold (** or __)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic (* or _)
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Fenced code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Convert remaining newlines to <br>
    html = html.replace(/\n/g, '<br>');
    return html;
}

// ========== MathJax rendering helper ==========
/**
 * Safely call MathJax to typeset formulas inside the given element.
 * Works with MathJax 3.x (typesetPromise) and falls back to 2.x (Hub.Queue).
 */
function renderMathInElementSafe(element) {
    if (typeof MathJax !== 'undefined' && MathJax.typesetPromise) {
        MathJax.typesetPromise([element]).catch(err => console.warn('MathJax typeset error:', err));
    } else if (typeof MathJax !== 'undefined' && MathJax.Hub) {
        MathJax.Hub.Queue(["Typeset", MathJax.Hub, element]);
    }
}

// ========== StreamHandler class ==========
/**
 * Manages the display of a single assistant message that arrives via SSE.
 * Shows a thinking block and a response block; applies Markdown, MathJax,
 * and RTL/LTR direction automatically.
 */
class StreamHandler {
    constructor(div, title) {
        this.div = div;
        this.thinkingDiv = div.querySelector('.thinking-content');
        this.responseDiv = div.querySelector('.response-content');
        this.title = title;
        this.titleShown = false;
        this.rawResponse = '';            // accumulated raw text
    }

    /** Display the action title (e.g. "Image Analysis") only once */
    showTitle() {
        if (!this.titleShown && this.title) {
            const span = document.createElement('span');
            span.className = 'action-title';
            span.textContent = this.title;
            this.div.prepend(span);
            this.titleShown = true;
        }
    }

    /** Add text to the thinking block (append mode) */
    addThinking(text) {
        this.showTitle();
        this.thinkingDiv.style.display = 'block';
        this.thinkingDiv.textContent += text;
        this.scroll();
    }

    /** Add a chunk of response text, re‑render Markdown and Math, and set direction */
    addResponse(text) {
        this.showTitle();
        this.rawResponse += text;
        this.responseDiv.style.display = 'block';
        this.responseDiv.innerHTML = renderMarkdown(this.rawResponse);
        // RTL/LTR based on Persian content
        if (containsPersian(this.rawResponse)) {
            this.responseDiv.classList.add('rtl');
            this.responseDiv.classList.remove('ltr');
        } else {
            this.responseDiv.classList.add('ltr');
            this.responseDiv.classList.remove('rtl');
        }
        renderMathInElementSafe(this.responseDiv);
        this.scroll();
    }

    /** Display an error message (red, with Markdown) */
    error(text) {
        this.responseDiv.style.display = 'block';
        this.responseDiv.innerHTML = `<span style="color:#ff8888">${renderMarkdown(text)}</span>`;
        this.scroll();
        this.finalize();
    }

    /** Finalise the stream – remove streaming class, clear handler, run MathJax */
    finalize() {
        this.div.classList.remove('streaming');
        currentStreamHandler = null;
        hideLoading();
        renderMathInElementSafe(this.div);

        // Re‑enable the controls once the response is complete
        sendBtn.disabled = false;
        attachBtn.disabled = false;
        console.log('[SidePanel] StreamHandler finalized, total length:', this.rawResponse.length);
    }

    /** Scroll the chat container to the bottom */
    scroll() { chatContainer.scrollTop = chatContainer.scrollHeight; }
}

// ========== Helper functions ==========

/** Add a user message (right‑aligned by default, RTL if Persian) */
function addUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'message user';
    if (containsPersian(text)) div.classList.add('rtl'); else div.classList.add('ltr');
    div.textContent = text;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    console.log('[SidePanel] User message:', text.substring(0, 50));
}

/** Add a static assistant message (not streaming) */
function addAssistantMessage(text, isError = false) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    if (containsPersian(text)) div.classList.add('rtl'); else div.classList.add('ltr');
    div.innerHTML = renderMarkdown(text);
    if (isError) div.style.color = '#ff8888';
    chatContainer.appendChild(div);
    renderMathInElementSafe(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

/** Show a "Processing…" placeholder while waiting for the first SSE event */
function showLoading() {
    let loading = document.getElementById('loadingMsg');
    if (!loading) {
        loading = document.createElement('div');
        loading.id = 'loadingMsg';
        loading.className = 'message assistant';
        loading.textContent = '⏳ Processing...';
        chatContainer.appendChild(loading);
    }
    console.log('[SidePanel] Loading indicator shown');
}

/** Remove the loading placeholder */
function hideLoading() {
    const el = document.getElementById('loadingMsg');
    if (el) el.remove();
}

/**
 * Start a new streaming response.
 * @param {string} userMessage - what to show as the user bubble
 * @param {string|null} actionTitle - optional title (e.g., "Image Analysis")
 * @param {string} prompt - the actual prompt sent to the server
 * @param {string|null} systemPrompt - reserved for future use
 * @param {object} options - additional flags (noAutoApiCall, imageBase64, …)
 */
function startStreaming(userMessage, actionTitle, prompt, systemPrompt, options = {}) {
    addUserMessage(userMessage);
    const assistantDiv = document.createElement('div');
    assistantDiv.className = 'message assistant streaming';
    assistantDiv.innerHTML = `<div class="thinking-content" style="display:none; color:#aaa; font-style:italic;"></div><div class="response-content" style="display:none;"></div>`;
    chatContainer.appendChild(assistantDiv);
    currentStreamHandler = new StreamHandler(assistantDiv, actionTitle);
    console.log('[SidePanel] Stream started with prompt:', prompt.substring(0, 60));

    if (options.imageBase64) {
        // Send image/file request via the persistent port
        streamPort.postMessage({
            type: "CALL_LOCAL_API_STREAM_IMAGE",
            streamId: Date.now() + '-' + Math.random(),
            prompt: prompt,
            systemPrompt: systemPrompt,
            imageBase64: options.imageBase64,
            imageMime: options.imageMime || 'application/octet-stream',
            fileName: options.fileName || 'file.bin',
            conversationId: conversationId
        });
    } else if (!options.noAutoApiCall) {
        // Normal text request via the persistent port
        streamPort.postMessage({
            type: "CALL_LOCAL_API_STREAM",
            prompt: prompt,
            systemPrompt,
            conversationId
        });
    }
}

// ========== New Chat ==========
/**
 * Resets the chat panel and creates a fresh conversation ID.
 */
async function startNewChat() {
    chatContainer.innerHTML = '<div class="message assistant">✅ New conversation started.</div>';
    localStorage.removeItem('deepseek_conversation_id');
    await chrome.storage.session.remove('conversationId');
    conversationId = crypto.randomUUID ? crypto.randomUUID() : 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    localStorage.setItem('deepseek_conversation_id', conversationId);
    await chrome.storage.session.set({ conversationId });
    clearSelectedFile();
    console.log('[SidePanel] New conversation started, id:', conversationId);
}

// ========== File attachment handling ==========
/** Remove the currently attached file and hide the preview bar */
function clearSelectedFile() {
    selectedFile = null;
    fileInput.value = '';
    attachBtn.classList.remove('has-file');
    attachBtn.title = 'Attach file';
    attachmentPreview.style.display = 'none';
    console.log('[SidePanel] Attachment cleared');
}

/** Show the file preview bar with the given file name */
function showAttachment(fileName) {
    attachmentFileName.textContent = fileName;
    attachmentPreview.style.display = 'flex';
    console.log('[SidePanel] Attachment preview shown:', fileName);
}

// Remove button inside the preview bar
removeAttachmentBtn.addEventListener('click', () => {
    clearSelectedFile();
});

// Open file picker when attach button is clicked
attachBtn.addEventListener('click', () => fileInput.click());

// When a file is chosen, read it as base64 and store it
fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(',')[1];
        selectedFile = {
            base64: base64,
            mimeType: file.type || 'application/octet-stream',
            name: file.name
        };
        attachBtn.classList.add('has-file');
        attachBtn.title = `File attached: ${file.name}`;
        showAttachment(file.name);
        console.log('[SidePanel] File selected:', file.name, 'type:', selectedFile.mimeType);
    };
    reader.readAsDataURL(file);
});

// ========== Manual send ==========
/**
 * Sends the current text + optional file, then clears input and attachment.
 * Blocks sending if a stream is already active to prevent lost responses.
 * Disables the send and attach buttons during streaming for clear visual feedback.
 */
function sendManual() {
    // Wait until the persistent port is fully established
    if (!portReady) {
        console.warn('[SidePanel] Port not ready yet - please wait');
        return;
    }
    // Prevent overlapping streams
    if (currentStreamHandler) {
        console.warn('[SidePanel] Cannot send – a stream is already in progress');
        return;
    }

    const text = messageInput.value.trim();
    if (!text && !selectedFile) return;

    messageInput.value = '';

    // Disable buttons while the stream is active
    sendBtn.disabled = true;
    attachBtn.disabled = true;

    if (selectedFile) {
        const prompt = text || "Please analyze this file and describe its contents.";
        const userMsg = text ? `📎 ${text}` : `📎 Sent a file for analysis`;
        startStreaming(userMsg, "📎 File Analysis", prompt, null, {
            imageBase64: selectedFile.base64,
            imageMime: selectedFile.mimeType,
            fileName: selectedFile.name
        });
    } else {
        startStreaming(text, null, text, null);
    }
    clearSelectedFile();
}

// ========== Event listeners ==========
sendBtn.addEventListener('click', sendManual);
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendManual();
    }
});
settingsBtn.onclick = () => settingsPanel.classList.add('open');
closeSettings.onclick = () => settingsPanel.classList.remove('open');
newChatBtn.onclick = startNewChat;

// Initialise the conversation ID on load
initConversationId();