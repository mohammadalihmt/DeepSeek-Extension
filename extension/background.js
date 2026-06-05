/**
 * background.js
 * Chrome Extension service worker.
 * Uses a persistent port for streaming data delivery to the side panel,
 * and chrome.runtime.sendMessage for one‑off messages (START_STREAMING, DISPLAY_RESULT).
 * A keep-alive alarm and heartbeat pings keep the worker alive during long requests.
 *
 * Responsibilities:
 *   - Forward text and file streaming requests to the local Flask server.
 *   - Manage a conversation ID stored in chrome.storage.session for continuity.
 *   - Create right‑click context menus for text, images, and page analysis.
 *   - Handle omnibox commands.
 *
 * All logging is done via console.log / console.warn.
 */

// ========== Constants ==========
const LOCAL_API_URL = 'http://localhost:8000/chat';


// ========== Conversation ID helpers ==========
/**
 * Retrieve the current conversation ID from session storage.
 * @returns {string|null}
 */
async function getConversationId() {
    const result = await chrome.storage.session.get('conversationId');
    return result.conversationId || null;
}

/**
 * Store a new conversation ID in session storage.
 * @param {string} id
 */
async function setConversationId(id) {
    await chrome.storage.session.set({ conversationId: id });
    console.log('[Background] ConversationId set to:', id);
}

// ========== Batched streaming sender ==========

/**
 * Creates a buffered sender that collects small response chunks
 * and sends them to the side panel in larger batches.
 * This prevents flooding the extension messaging channel.
 *
 * @param {string} streamId - unique identifier for the current stream
 * @param {Object} port - the persistent port to the side panel
 * @returns {{ addChunk: function(string), finalize: function }}
 */
function createStreamSender(streamId, port) {
    let buffer = '';
    let timer = null;
    const FLUSH_INTERVAL = 150;   // ms between forced flushes
    const FLUSH_SIZE = 300;       // characters before an automatic flush

    // Flush the buffer and optionally call a callback after sending
    function flush(onFlushed = null) {
        if (!buffer) {
            if (onFlushed) onFlushed();
            return;
        }
        console.log(`[Background] Flushing batch of length ${buffer.length} for stream ${streamId}`);
        port.postMessage({
            type: "STREAMING_DATA",
            streamId,
            data: { type: "response", content: buffer }
        });
        buffer = '';
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        // Call the callback after the message is posted
        // Use setTimeout to ensure the message is processed before the callback
        if (onFlushed) {
            setTimeout(onFlushed, 0);
        }
    }

    /**
     * Add a new chunk of text. If the buffer reaches FLUSH_SIZE, flush immediately;
     * otherwise, schedule a flush after FLUSH_INTERVAL ms.
     * @param {string} text
     */
    function addChunk(text) {
        buffer += text;
        if (buffer.length >= FLUSH_SIZE) {
            flush();
        } else if (!timer) {
            timer = setTimeout(() => flush(), FLUSH_INTERVAL);
        }
    }

    /**
     * Flush any remaining text. Should be called when the stream ends.
     */
    function finalize() {
        flush(() => {
            port.postMessage({
                type: "STREAMING_DATA", streamId,
                data: { type: "done" }
            });
        });
    }

    return { addChunk, finalize };
}

// ========== Server communication ==========

/**
 * Send a normal streaming request (text only) to the local API.
 * SSE response chunks are parsed and forwarded to the side panel.
 *
 * @param {string} prompt - user message
 * @param {string|null} systemPrompt - optional system instruction
 * @param {string} streamId - unique stream identifier
 * @param {string|null} conversationId - conversation ID for history
 * @param {Object} port - the persistent port to the side panel
 */
async function callLocalAPIStream(prompt, systemPrompt, streamId, conversationId, port) {
    try {
        const payload = { prompt, _stream: true, conversation_id: conversationId };
        if (systemPrompt) payload.systemPrompt = systemPrompt;

        console.log('[Background] callLocalAPIStream:', payload);

        const response = await fetch(LOCAL_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Background] Server error:', response.status, errorText.substring(0, 100));
            port.postMessage({
                type: "STREAMING_DATA", streamId,
                data: { type: "error", content: `Server error (${response.status}): ${errorText.substring(0, 100)}` }
            });
            return;
        }

        // Read the SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const sender = createStreamSender(streamId, port);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // keep incomplete line in buffer
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.type === 'response') {
                            sender.addChunk(data.content);
                            console.log(`[Background] SSE response chunk length: ${data.content.length}`);
                        } else if (data.type !== 'done') {
                            console.log(`[Background] SSE event type: ${data.type}`);
                            port.postMessage({
                                type: "STREAMING_DATA", streamId, data
                            });
                        }
                    } catch (e) {
                        console.error('[Background] Failed to parse SSE line:', line.substring(0, 100), e);
                    }
                }
            }
        }
        sender.finalize();
        setTimeout(() => {
            port.postMessage({
                type: "STREAMING_DATA", streamId,
                data: { type: "done" }
            });
        }, 0);
        console.log('[Background] Stream completed:', streamId);

    } catch (error) {
        console.error('[Background] callLocalAPIStream error:', error);
        port.postMessage({
            type: "STREAMING_DATA", streamId,
            data: { type: "error", content: error.message }
        });
    }
}

/**
 * Send a non‑streaming request (used for page analysis).
 * @param {string} prompt
 * @param {string|null} systemPrompt
 * @returns {Promise<string>} the response text or error message
 */
async function callLocalAPI(prompt, systemPrompt) {
    try {
        const res = await fetch(LOCAL_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, systemPrompt })
        });
        const data = await res.json();
        return data.response || data.error || "No response";
    } catch (err) {
        console.error('[Background] callLocalAPI error:', err);
        return `Network error: ${err.message}`;
    }
}

// ========== File handling (any file as base64) ==========

/**
 * Download a remote image and convert it to a base64 string.
 * Used for right‑click “Analyze image” context menu.
 * @param {string} imageUrl
 * @returns {{ base64: string, mimeType: string }}
 */
async function fetchAndConvertToBase64(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const blob = await response.blob();
    const mimeType = blob.type || 'application/octet-stream';
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(',')[1];
            resolve({ base64, mimeType });
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Send a streaming request that includes a file (base64‑encoded).
 * Works exactly like callLocalAPIStream but also passes file data.
 *
 * @param {string} prompt
 * @param {string|null} systemPrompt
 * @param {string} streamId
 * @param {string} imageBase64 - file content as base64
 * @param {string} imageMime - MIME type of the file
 * @param {string|null} conversationId
 * @param {string} fileName - original file name (used to keep the correct extension)
 * @param {Object} port - the persistent port to the side panel
 */
async function callLocalAPIStreamWithImage(prompt, systemPrompt, streamId, imageBase64, imageMime, conversationId, fileName, port) {
    try {
        const payload = {
            prompt,
            _stream: true,
            image: imageBase64,
            conversation_id: conversationId,
            file_name: fileName || 'file.bin'
        };
        if (systemPrompt) payload.systemPrompt = systemPrompt;

        console.log('[Background] callLocalAPIStreamWithImage:', { prompt: prompt.substring(0, 60), fileName });

        const response = await fetch(LOCAL_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Background] Server error (image):', response.status, errorText.substring(0, 100));
            port.postMessage({
                type: "STREAMING_DATA", streamId,
                data: { type: "error", content: `Server error (${response.status}): ${errorText.substring(0, 100)}` }
            });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const sender = createStreamSender(streamId, port);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.type === 'response') {
                            sender.addChunk(data.content);
                            console.log(`[Background] SSE response chunk length: ${data.content.length}`);
                        } else if (data.type !== 'done') {
                            console.log(`[Background] SSE event type: ${data.type}`);
                            port.postMessage({
                                type: "STREAMING_DATA", streamId, data
                            });
                        }
                    } catch (e) {
                        console.error('[Background] Failed to parse SSE line:', line.substring(0, 100), e);
                    }
                }
            }
        }
        sender.finalize();
        setTimeout(() => {
            port.postMessage({
                type: "STREAMING_DATA", streamId,
                data: { type: "done" }
            });
        }, 0);
        console.log('[Background] Stream completed:', streamId);

    } catch (error) {
        console.error('[Background] callLocalAPIStreamWithImage error:', error);
        port.postMessage({
            type: "STREAMING_DATA", streamId,
            data: { type: "error", content: error.message }
        });
    }
}

/**
 * Handle a right‑click “Analyze image” or “Execute task from image” request.
 * Downloads the image, converts to base64, and streams it with the chosen prompt.
 *
 * @param {string} imageUrl - URL of the image
 * @param {number} tabId - browser tab ID (unused but kept for context)
 * @param {string} prompt - analysis prompt
 */
async function handleImageAnalysis(imageUrl, tabId, prompt) {
    const streamId = Date.now() + '-' + Math.random();
    let convId = await getConversationId();
    if (!convId) {
        convId = crypto.randomUUID ? crypto.randomUUID() : 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
        await setConversationId(convId);
    }

    // Notify the side panel to prepare for a new stream (via chrome.runtime.sendMessage since the port may not be ready)
    chrome.runtime.sendMessage({
        type: "START_STREAMING",
        userMessage: `🖼️ Analyzing image from ${imageUrl.substring(0, 60)}...`,
        actionTitle: "🖼️ Image Analysis",
        prompt: prompt,
        systemPrompt: null,
        image: true,
        noAutoApiCall: true,
        conversationId: convId
    }).catch(() => {});

    try {
        const { base64, mimeType } = await fetchAndConvertToBase64(imageUrl);
        const urlPath = new URL(imageUrl).pathname;
        const fileName = urlPath.substring(urlPath.lastIndexOf('/') + 1) || 'image.png';
        // For context menu streams, get the currently active stream port (if the side panel is open)
        const port = getStreamPort();
        if (port) {
            callLocalAPIStreamWithImage(prompt, null, streamId, base64, mimeType, convId, fileName, port);
        } else {
            console.warn('[Background] No side panel stream port available for image analysis');
        }
    } catch (error) {
        console.error('[Background] Image analysis error:', error);
        chrome.runtime.sendMessage({
            type: "STREAMING_DATA", streamId,
            data: { type: "error", content: `Image analysis error: ${error.message}` }
        }).catch(() => {});
    }
}

// ========== Stream port management ==========
let streamPort = null;

/**
 * Return the currently active persistent port to the side panel.
 * @returns {Object|null}
 */
function getStreamPort() {
    return streamPort;
}

/**
 * Handle new persistent connections from the side panel.
 * The side panel opens a port named 'sidepanel-stream' on load.
 */
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sidepanel-stream') return;  // only interested in side panel connections
    console.log('[Background] Side panel stream port connected');
    streamPort = port;

    // Listen for messages from the side panel via the persistent port
    port.onMessage.addListener((request) => {
        // --- Respond to heartbeats (keep-alive pings) ---
        if (request.type === 'ping') {
            port.postMessage({ type: 'pong' });
            return;
        }
        // --- Normal text streaming request ---
        if (request.type === "CALL_LOCAL_API_STREAM") {
            const streamId = Date.now() + '-' + Math.random();
            callLocalAPIStream(request.prompt, request.systemPrompt, streamId, request.conversationId, port);
        }
        // --- Image/file streaming request ---
        if (request.type === "CALL_LOCAL_API_STREAM_IMAGE") {
            const streamId = request.streamId || (Date.now() + '-' + Math.random());
            callLocalAPIStreamWithImage(
                request.prompt,
                request.systemPrompt,
                streamId,
                request.imageBase64,
                request.imageMime,
                request.conversationId,
                request.fileName,
                port
            );
        }
    });

    // Clean up when the side panel closes
    port.onDisconnect.addListener(() => {
        console.log('[Background] Side panel stream port disconnected');
        streamPort = null;
    });
});

// ========== One‑off message listener (for content script, context menus, omnibox) ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Wake-up call from side panel – simply reply to confirm we're alive
    if (request.type === 'WAKEUP') {
        sendResponse({ status: 'ok' });
        return true;
    }
    // Page analysis from content script (non‑streaming)
    if (request.type === "CALL_LOCAL_API") {
        callLocalAPI(request.prompt, request.systemPrompt)
            .then(res => sendResponse({ success: true, response: res }))
            .catch(err => sendResponse({ success: false, response: err.message }));
        return true;
    }
    // DISPLAY_RESULT from content script – forward to side panel
    if (request.type === "DISPLAY_RESULT") {
        chrome.runtime.sendMessage(request).catch(() => {});
    }
    return false;
});

// ========== Extension install & context menus ==========

chrome.runtime.onInstalled.addListener(() => {
    // Enable the side panel globally
    chrome.sidePanel.setOptions({ enabled: true });

    // Define all right‑click context menu items
    const menus = [
        { id: "askDeepSeek",       title: "Ask DeepSeek: '%s'",      contexts: ["selection"] },
        { id: "explainDeepSeek",   title: "Explain: '%s'",           contexts: ["selection"] },
        { id: "translateDeepSeek", title: "Translate to English: '%s'", contexts: ["selection"] },
        { id: "summarizeDeepSeek", title: "Summarize: '%s'",         contexts: ["selection"] },
        { id: "analyzeImage",      title: "🖼️ Analyze this image",   contexts: ["image"] },
        { id: "executeTaskImage",  title: "🖼️ Execute task from image", contexts: ["image"] },
        { id: "analyzePage",       title: "🔍 Analyze full page",    contexts: ["page"] },
        { id: "summarizePage",     title: "📄 Summarize this page",  contexts: ["page"] },
        { id: "extractTables",     title: "📊 Extract tables",       contexts: ["page"] },
        { id: "extractImages",     title: "🖼️ Describe images on page", contexts: ["page"] }
    ];
    menus.forEach(m => chrome.contextMenus.create(m));
    console.log('[Background] Context menus created');
});

// ========== Context menu clicks ==========

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;

    // ---- Text selection menus ----
    if (info.selectionText && !["analyzePage","summarizePage","extractTables","extractImages","analyzeImage","executeTaskImage"].includes(info.menuItemId)) {
        let systemPrompt = "", actionTitle = "";
        switch (info.menuItemId) {
            case "explainDeepSeek":   systemPrompt = "Explain the following text:"; actionTitle = "📖 Explanation"; break;
            case "translateDeepSeek": systemPrompt = "Translate to English:";       actionTitle = "🌐 Translation"; break;
            case "summarizeDeepSeek": systemPrompt = "Summarize concisely:";        actionTitle = "📝 Summary"; break;
            default:                  systemPrompt = "Answer the following question:"; actionTitle = "💬 Answer";
        }
        const fullPrompt = `${systemPrompt}\n\n${info.selectionText}`;
        await chrome.sidePanel.open({ tabId: tab.id });
        await new Promise(r => setTimeout(r, 300));
        chrome.runtime.sendMessage({ type: "START_STREAMING", userMessage: fullPrompt, actionTitle, prompt: info.selectionText, systemPrompt }).catch(() => {});
        console.log('[Background] Context menu action:', info.menuItemId);
    }
    // ---- Image analysis (describe) ----
    else if (info.menuItemId === "analyzeImage" && info.srcUrl) {
        await chrome.sidePanel.open({ tabId: tab.id });
        await new Promise(r => setTimeout(r, 300));
        handleImageAnalysis(info.srcUrl, tab.id, "Please analyze this image and describe what you see in detail.");
    }
    // ---- Image analysis (execute task) ----
    else if (info.menuItemId === "executeTaskImage" && info.srcUrl) {
        await chrome.sidePanel.open({ tabId: tab.id });
        await new Promise(r => setTimeout(r, 300));
        handleImageAnalysis(info.srcUrl, tab.id, "Please analyze this image and perform the task it describes.");
    }
    // ---- Page analysis ----
    else if (["analyzePage","summarizePage","extractTables","extractImages"].includes(info.menuItemId)) {
        await chrome.sidePanel.open({ tabId: tab.id });
        chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE", action: info.menuItemId }).catch(err => console.error('[Background] sendMessage failed:', err));
        console.log('[Background] Page analysis requested:', info.menuItemId);
    }
});

// ========== Omnibox (address bar) ==========

/**
 * Listen for commands typed after the keyword "ds" in the address bar.
 * Opens the side panel and sends the text as a prompt.
 */
chrome.omnibox.onInputEntered.addListener(async (text) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ tabId: tabs[0].id });
    chrome.runtime.sendMessage({ type: "START_STREAMING", userMessage: text, actionTitle: "💬 Answer", prompt: text, systemPrompt: null }).catch(() => {});
    console.log('[Background] Omnibox command:', text);
});