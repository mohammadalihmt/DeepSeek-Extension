/**
 * content.js
 * Injected into every page to support right‑click “page analysis” actions.
 * It extracts page text, tables, and images, then sends them to the local API
 * via the background script.  Results are displayed in the side panel.
 */

// ========== Helper: show a temporary notification ==========

/**
 * Displays a brief toast‑style message at the bottom of the page.
 * @param {string} msg - message text
 */
function showNotification(msg) {
    const div = document.createElement('div');
    div.textContent = msg;
    div.style.cssText =
        'position:fixed; bottom:20px; left:20px; right:20px; ' +
        'background:rgba(0,0,0,0.9); color:#00d2ff; padding:12px; ' +
        'border-radius:8px; text-align:center; z-index:10001; ' +
        'animation:fadeOut 3s forwards;';
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
    console.log('[Content] Notification:', msg);
}

// ========== Page content extraction ==========

/**
 * Scrapes the current page for visible text (limited), tables, and images.
 * @returns {{ text: string, images: Array, tables: Array, structuredText: string, url: string, title: string }}
 */
function extractPageContent() {
    const content = {
        text: '',
        images: [],
        tables: [],
        structuredText: '',
        url: location.href,
        title: document.title
    };

    // Gather all visible text from common elements (max 10 k characters)
    const allText = Array.from(
        document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, div')
    )
        .map(el => el.innerText?.trim())
        .filter(Boolean)
        .join(' ');
    content.text = allText.substring(0, 10000);

    // Extract tables with headers and rows
    const tables = document.querySelectorAll('table');
    tables.forEach((table, idx) => {
        const headers = Array.from(table.querySelectorAll('th')).map(th =>
            th.innerText.trim()
        );
        const rows = Array.from(table.querySelectorAll('tr'))
            .map(tr =>
                Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
            )
            .filter(row => row.length);
        if (rows.length) {
            content.tables.push({
                index: idx,
                headers,
                rows,
                textRepresentation:
                    headers.join(' | ') +
                    '\n' +
                    rows.map(r => r.join(' | ')).join('\n')
            });
        }
    });

    // Extract images (only those with a valid http(s) src)
    const images = document.querySelectorAll('img');
    images.forEach(img => {
        if (img.src && img.src.startsWith('http')) {
            content.images.push({
                src: img.src,
                alt: img.alt || '',
                title: img.title || '',
                width: img.width,
                height: img.height,
                context: img.parentElement?.innerText?.substring(0, 200) || ''
            });
        }
    });

    console.log(
        '[Content] Extracted page – text length:',
        content.text.length,
        'tables:',
        content.tables.length,
        'images:',
        content.images.length
    );
    return content;
}

// ========== Page analysis & send to server ==========

/**
 * Builds a prompt from the extracted page data and sends it to the local API
 * through the background script.  The response is displayed via DISPLAY_RESULT.
 * @param {string} action - one of "analyzePage", "summarizePage", "extractTables", "extractImages"
 */
async function analyzePageAndSend(action) {
    const page = extractPageContent();
    let systemPrompt = '',
        userPrompt = '';

    switch (action) {
        case 'analyzePage':
            systemPrompt = 'Analyze this webpage thoroughly.';
            userPrompt = `Title: ${page.title}\nURL: ${page.url}\nText: ${page.text}\nTables: ${page.tables.map(t => t.textRepresentation).join('\n')}\nImages: ${page.images.map(i => i.alt).join(', ')}`;
            break;
        case 'summarizePage':
            systemPrompt = 'Summarize this webpage concisely.';
            userPrompt = `Title: ${page.title}\nText: ${page.text}`;
            break;
        case 'extractTables':
            systemPrompt = 'Extract all tables.';
            userPrompt = page.tables.map(t => t.textRepresentation).join('\n\n');
            break;
        case 'extractImages':
            systemPrompt = 'Describe all images.';
            userPrompt = page.images.map(i => `${i.alt}: ${i.context}`).join('\n');
            break;
        default:
            console.warn('[Content] Unknown page action:', action);
            return;
    }

    console.log('[Content] Sending page analysis request:', action);

    // Call the non‑streaming API endpoint via background
    const response = await new Promise(resolve => {
        chrome.runtime.sendMessage(
            { type: 'CALL_LOCAL_API', prompt: userPrompt, systemPrompt },
            res => resolve(res?.success ? res.response : 'Error')
        );
    });

    // Forward the result to the side panel
    chrome.runtime.sendMessage({
        type: 'DISPLAY_RESULT',
        result: response,
        action,
        prompt: `📄 ${action}: ${page.title}`
    });
    console.log('[Content] Page analysis result received, length:', response?.length);
}

// ========== Message listener (from background) ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'EXTRACT_PAGE') {
        analyzePageAndSend(request.action);
    }
    // Note: image analysis is now handled entirely by background.js,
    // so no ANALYZE_IMAGE case is needed here.
    return true; // keep the channel open for async response
});

// ========== Add fade‑out animation ==========

const style = document.createElement('style');
style.textContent =
    '@keyframes fadeOut { ' +
    '0% { opacity: 1; } ' +
    '70% { opacity: 1; } ' +
    '100% { opacity: 0; visibility: hidden; } ' +
    '}';
document.head.appendChild(style);