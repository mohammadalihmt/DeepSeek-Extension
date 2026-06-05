<h1 align="center">🤖 DeepSeek Local Assistant</h1>
<p align="center">
  <img src="extension/icons/icon128.png" alt="logo" width="100" class="logo"/>
</p>
<p align="center">
  <strong>Free, private, and full‑response Chrome extension for DeepSeek</strong><br>
  Uses your own <code>chat.deepseek.com</code> token – no paid API key required!
</p>

<p align="center">
  <a href="#-features">✨ Features</a> •
  <a href="#-architecture">🏗 Architecture</a> •
  <a href="#-installation">🚀 Installation</a> •
  <a href="#-configuration">🔧 Configuration</a> •
  <a href="#-usage">💬 Usage</a> •
  <a href="#-troubleshooting">⚠️ Troubleshooting</a> •
  <a href="#-support">💖 Support</a>
</p>

---

<h2 id="-features">✨ Features</h2>
<ul>
  <li><strong>Full‑response delivery</strong> – the complete answer appears once DeepSeek finishes processing</li>
  <li><strong>File upload</strong> – send PDF, DOCX, images, audio, code, and more directly from the side panel</li>
  <li><strong>Right‑click context menus</strong> – analyze images or selected text on any web page</li>
  <li><strong>Full Markdown &amp; LaTeX rendering</strong> – beautiful tables, headings, code blocks, and math formulas (offline MathJax)</li>
  <li><strong>Conversation continuity</strong> – remembers your chat history until you close the panel or click New Chat</li>
  <li><strong>New chat button</strong> – start a fresh conversation anytime</li>
  <li><strong>RTL / LTR auto‑detection</strong> – Persian and English messages are aligned correctly</li>
  <li><strong>Persistent connection</strong> – a dedicated port keeps the background worker alive for reliable message delivery</li>
  <li><strong>Zero Python setup (for regular users)</strong> – download the ready‑to‑run <code>DeepSeekServer.exe</code> and start immediately</li>
  <li><strong>100% local</strong> – only your own <code>chat.deepseek.com</code> token is used; no third‑party APIs</li>
</ul>

---

<h2 id="-architecture">🏗 Architecture</h2>
<pre>
DeepSeek-Project/
├── extension/               Chrome extension (loads in developer mode)
│   ├── manifest.json
│   ├── background.js        Service worker – API requests, context menus, persistent port
│   ├── content.js           Injected script – page extraction &amp; image analysis
│   ├── sidepanel.html       Side panel UI
│   ├── sidepanel.js         Chat logic, Markdown rendering, file preview, persistent port
│   ├── icons/               Extension icons (16, 32, 48, 128)
│   └── mathjax/             MathJax offline bundle (tex-mml-chtml.js)
└── server/                  Python backend (Flask)
    ├── local_api.py         SSE server – file upload, conversation persistence, non‑streaming response
    ├── vendor/              Bundled, patched version of the deepseek library
    │   └── deepseek/        (no need to install p2d-deepseek separately)
    ├── requirements.txt     Python dependencies (Flask, flask-cors)
    ├── token.txt            Your DeepSeek token (created on first run)
    └── dist/                (optional) contains the standalone DeepSeekServer.exe after build
</pre>

---

<h2 id="-installation">🚀 Installation</h2>

<h3>Option A: Use the standalone executable (recommended for most users)</h3>
<ol>
  <li>Download the latest <code>DeepSeekServer.exe</code> from the <a href="https://github.com/mohammadalihmt/DeepSeek-Extension/releases">Releases page</a>.</li>
  <li>Place it in a folder (e.g. <code>C:\DeepSeek</code>).</li>
  <li>Double‑click <code>DeepSeekServer.exe</code> – a console window will open and the server starts.</li>
  <li>On first run, a <code>token.txt</code> file is created next to the executable. Open it with Notepad, paste your DeepSeek token, save, and restart the server.</li>
  <li>Load the extension in Chrome (see “Load the extension” below).</li>
</ol>

<h3>Option B: Run directly with Python (for developers)</h3>
<ol>
  <li>Clone this repository or download the ZIP.</li>
  <li>Open a terminal in the <code>server/</code> folder and install the dependencies:
    <pre>pip install -r requirements.txt   # installs Flask and flask-cors</pre>
  </li>
  <li>The modified <code>deepseek</code> library is already included in the <code>vendor/</code> folder – no extra patches are needed.</li>
  <li>Obtain your DeepSeek token (see <a href="#-configuration">Configuration</a>) and either set the <code>DEEPSEEK_TOKEN</code> environment variable or create a <code>token.txt</code> file with your token.</li>
  <li>Start the server:
    <pre>python local_api.py</pre>
  </li>
  <li>Load the extension in Chrome (see below).</li>
</ol>

<h3>Load the extension in Chrome</h3>
<ol>
  <li>Open <code>chrome://extensions</code> in your browser.</li>
  <li>Turn on <strong>Developer mode</strong> (toggle in the top‑right).</li>
  <li>Click <strong>Load unpacked</strong> and select the <code>extension/</code> folder.</li>
  <li>Pin the extension for easy access.</li>
</ol>

---

<h2 id="-configuration">🔧 Configuration</h2>

<h3>Getting your user token</h3>
<ol>
  <li>Go to <a href="https://chat.deepseek.com">chat.deepseek.com</a> and log in.</li>
  <li>Open Developer Tools (<code>F12</code>) → <strong>Application</strong> → <strong>Local Storage</strong> → <code>https://chat.deepseek.com</code>.</li>
  <li>Copy the value of the key <code>userToken</code>.</li>
  <li>If using the standalone executable, paste the token into the <code>token.txt</code> file next to <code>DeepSeekServer.exe</code>.<br>
      If running directly with Python, either set the <code>DEEPSEEK_TOKEN</code> environment variable or create a <code>token.txt</code> file in the <code>server/</code> folder.</li>
</ol>
<p><strong>Never share this token</strong> – it grants full access to your DeepSeek account.</p>

---

<h2 id="-usage">💬 Usage</h2>

<h3>Side panel chat</h3>
<ul>
  <li>Click the extension icon or press <kbd>Ctrl+Shift+Y</kbd> to open the side panel.</li>
  <li>Type your question and press <strong>Enter</strong> (Shift+Enter for a new line).</li>
  <li>The full response appears once DeepSeek finishes processing, with Markdown and math rendered beautifully.</li>
</ul>

<h3>File upload</h3>
<ul>
  <li>Click the 📎 button next to the input field.</li>
  <li>Select any supported file (PDF, DOCX, XLSX, PPTX, images, audio, code, etc.).</li>
  <li>A preview bar shows the file name above the input area.</li>
  <li>Optionally type a question and press <strong>Enter</strong> to send.</li>
</ul>

<h3>Right‑click context menus</h3>
<ul>
  <li><strong>Text selection</strong>: explain, translate, summarise, or ask DeepSeek about selected text.</li>
  <li><strong>Images</strong>: right‑click any image on a webpage and choose “Analyze this image” or “Execute task from image”.</li>
  <li><strong>Pages</strong>: right‑click anywhere on a page to analyse, summarise, extract tables, or describe all images.</li>
</ul>

<h3>New conversation</h3>
<ul>
  <li>Click the ➕ button at the top of the side panel to start a fresh chat.</li>
</ul>

<h3>Settings</h3>
<ul>
  <li>Click ⚙️ to see server info and support details.</li>
</ul>

---

<h2 id="-troubleshooting">⚠️ Troubleshooting</h2>
<table>
  <tr>
    <th>Issue</th>
    <th>Solution</th>
  </tr>
  <tr>
    <td><strong>“Client not available”</strong></td>
    <td>Make sure the server is running and your token is correct. If using the executable, check that <code>token.txt</code> contains your real token (not the placeholder).</td>
  </tr>
  <tr>
    <td><strong>File upload fails with error 50300 / 50404</strong></td>
    <td>The file may be too large, password‑protected, or contain unsupported content. If you are running directly with Python, ensure the <code>vendor/deepseek</code> folder is present and has not been modified. Try a different file.</td>
  </tr>
  <tr>
    <td><strong>Math formulas not rendering</strong></td>
    <td>Check that <code>mathjax/tex-mml-chtml.js</code> exists inside the <code>extension/mathjax/</code> folder. Open the side panel’s DevTools (<code>F12</code> on the panel) for 404 errors.</td>
  </tr>
  <tr>
    <td><strong>Conversation restarts every message</strong></td>
    <td>Do not restart the server between messages – conversation state is kept in memory. If you must restart, click <strong>➕</strong> to start a new conversation manually.</td>
  </tr>
  <tr>
    <td><strong>Side panel stays on “Analyzing…” forever</strong></td>
    <td>Open the side panel’s DevTools (<code>F12</code> on the panel) once; this wakes the background service worker. The persistent connection will then keep it alive.</td>
  </tr>
</table>

---

<h2 id="-support">💖 Support</h2>
<p>I hope this extension has been useful! To support me:</p>
<ul>
  <li>Follow my GitHub account <strong>@mohammadalihmt</strong></li>
  <li>⭐ Star this repository</li>
  <li>Share it with friends who might find it helpful</li>
</ul>
<p>Feel free to open an issue if you encounter any bugs or have feature requests.</p>

<hr>
<p align="center"><strong>Made with ❤️ and Python</strong></p>
