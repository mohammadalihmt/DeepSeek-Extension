"""
local_api.py – Flask server for the DeepSeek Chrome extension.
Bridges the extension to DeepSeek via the p2d-deepseek library.

Endpoints:
    POST /chat   – accepts a prompt + optional file (base64) and returns an SSE stream
                   that includes thinking messages and the final assistant response.

Conversation state is kept in memory (dictionary `conversations`).
Start with: python local_api.py   (or use start_api.bat on Windows)
"""

import sys
import os

# ========== Startup banner ==========
print("======================================", file=sys.stderr, flush=True)
print("   Starting DeepSeek API Server", file=sys.stderr, flush=True)
print("======================================", file=sys.stderr, flush=True)
print(file=sys.stderr, flush=True)

# Ensure the bundled (patched) deepseek library is used
_here = os.path.dirname(os.path.abspath(__file__))
_vendor = os.path.join(_here, "vendor")
if _vendor not in sys.path:
    sys.path.insert(0, _vendor)

# Now import the library normally
from deepseek import DeepSeekClient, DeepSeekAPIError

from flask import Flask, Response, request, jsonify
from flask_cors import CORS
import json
import sys
import uuid
import tempfile
import base64
from deepseek import DeepSeekClient, DeepSeekAPIError

app = Flask(__name__)
CORS(app)


# =====================================================================
# Token loading
# Priority: 1) DEEPSEEK_TOKEN environment variable
#           2) token.txt file in the executable/server folder
# =====================================================================
def load_token():
    # 1. Environment variable
    env_token = os.environ.get("DEEPSEEK_TOKEN")
    if (
        env_token
        and env_token.strip()
        and env_token.strip() != "YOUR_ACTUAL_TOKEN_HERE"
    ):
        return env_token.strip()

    # 2. token.txt file (same directory as the script or executable)
    if getattr(sys, "frozen", False):
        # Running as a bundled executable
        base_dir = os.path.dirname(sys.executable)
    else:
        # Running as a normal Python script
        base_dir = os.path.dirname(os.path.abspath(__file__))

    token_file = os.path.join(base_dir, "token.txt")
    if os.path.exists(token_file):
        with open(token_file, "r", encoding="utf-8") as f:
            token = f.read().strip()
            if token and token != "YOUR_ACTUAL_TOKEN_HERE":
                return token
            else:
                print(
                    "[API] ERROR: token.txt contains a placeholder. Replace it with your real token.",
                    file=sys.stderr,
                    flush=True,
                )
    else:
        # Create a template file
        with open(token_file, "w", encoding="utf-8") as f:
            f.write("YOUR_ACTUAL_TOKEN_HERE")
        print(
            f"[API] Created '{token_file}'. Open it with Notepad and paste your DeepSeek token, then restart the server.",
            file=sys.stderr,
            flush=True,
        )

    return None  # No valid token found


USER_TOKEN = load_token()
if not USER_TOKEN:
    print(
        "FATAL: No DeepSeek token found. Please set the DEEPSEEK_TOKEN environment variable or edit token.txt",
        file=sys.stderr,
        flush=True,
    )
    # Don't exit immediately – let Flask start so the user can see the error in the browser.
    # The client will show "Client not available" for every request.

import logging

# Suppress noisy Werkzeug logs (only errors are shown)
log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

# =====================================================================
# In‑memory conversation store
# Maps conversation_id → { "client": DeepSeekClient, "session_id": str }
# =====================================================================
conversations = {}


def get_conversation(conversation_id):
    """
    Retrieve an existing conversation or create a new one.
    Each conversation keeps its own DeepSeekClient instance,
    which maintains the chat session and cookies for history continuity.
    """
    if not conversation_id:
        conversation_id = str(uuid.uuid4())
    if conversation_id not in conversations:
        conversations[conversation_id] = {
            "client": DeepSeekClient(api_key=USER_TOKEN),
            "session_id": None,
        }
    return conversation_id, conversations[conversation_id]


def generate_stream(
    prompt, image_base64=None, conversation_id=None, file_name="file.png"
):
    """
    Generator that yields Server‑Sent Events (SSE) lines.

    Steps:
        1. Send a conversation_id event so the extension stays in sync.
        2. Send a thinking message to indicate processing has started.
        3. If a file is attached, upload it to DeepSeek.
        4. Call the chat API (non‑streaming).
        5. Send the entire response as a single 'response' event.
        6. Send a 'done' event to signal completion.
    """
    conv_id, conv = get_conversation(conversation_id)
    client = conv["client"]
    session_id = conv["session_id"]

    # Log basic request info
    print(
        f"[API] Stream conv={conv_id[:8]} session={session_id} prompt={prompt[:60]}...",
        file=sys.stderr,
        flush=True,
    )
    print(
        f"[API] file_name={file_name}, image_base64 len={len(image_base64) if image_base64 else 0}",
        file=sys.stderr,
        flush=True,
    )

    # 1. Send the conversation ID back to the extension so it stays in sync
    yield f"data: {json.dumps({'type': 'conversation_id', 'content': conv_id})}\n\n"
    # 2. Initial thinking message
    yield f"data: {json.dumps({'type': 'thinking', 'content': '🤔 Analyzing your request...'})}\n\n"
    sys.stdout.flush()

    temp_file_path = None
    file_ids = []

    try:
        # ---------- 3. File upload ----------
        if image_base64:
            # Preserve the original file extension (important for correct MIME type)
            suffix = os.path.splitext(file_name)[1] or ".png"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(base64.b64decode(image_base64))
                temp_file_path = tmp.name

            yield f"data: {json.dumps({'type': 'thinking', 'content': '📤 Uploading file...'})}\n\n"
            sys.stdout.flush()

            try:
                # Upload using the library (handles PoW and MIME automatically)
                file_id = client.upload_file(temp_file_path)
                file_ids.append(file_id)
                print(f"[API] File uploaded: {file_id}", file=sys.stderr, flush=True)

                yield f"data: {json.dumps({'type': 'thinking', 'content': '📎 File uploaded. Analyzing...'})}\n\n"
                sys.stdout.flush()

            except DeepSeekAPIError as api_err:
                # API‑level errors from DeepSeek (e.g., 50300)
                print(
                    f"[API] DeepSeek API Error: {api_err}", file=sys.stderr, flush=True
                )
                yield f"data: {json.dumps({'type': 'error', 'content': f'File upload failed: {api_err}'})}\n\n"
                sys.stdout.flush()
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                sys.stdout.flush()
                return  # Stop the generator – no chat call
            except Exception as upload_error:
                # Any other unexpected error during upload
                print(
                    f"[API] Upload error: {upload_error}", file=sys.stderr, flush=True
                )
                import traceback

                traceback.print_exc()
                yield f"data: {json.dumps({'type': 'error', 'content': f'Upload failed: {str(upload_error)}'})}\n\n"
                sys.stdout.flush()
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                sys.stdout.flush()
                return

        # ---------- 4. Chat completion (non‑streaming) ----------
        response_obj = client.chat(prompt, session_id=session_id, file_ids=file_ids)

        # Store the session_id for subsequent messages in the same conversation
        if not conv["session_id"]:
            conv["session_id"] = response_obj.session_id
            print(
                f"[API] Stored session_id: {conv['session_id']}",
                file=sys.stderr,
                flush=True,
            )

        response_text = response_obj.response
        print(
            f"[API] Response length: {len(response_text)}", file=sys.stderr, flush=True
        )

        # 5. Send the entire response as a single SSE event
        yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
        sys.stdout.flush()

        # 6. Signal the end of the stream
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        sys.stdout.flush()

    except Exception as e:
        # Catch‑all for any unexpected error during chat
        print(f"[API] Unexpected error: {e}", file=sys.stderr, flush=True)
        import traceback

        traceback.print_exc()
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
        sys.stdout.flush()
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        sys.stdout.flush()
    finally:
        # Clean up the temporary file
        if temp_file_path and os.path.exists(temp_file_path):
            os.unlink(temp_file_path)


# =====================================================================
# Flask route: /chat
# Expects JSON with:
#   prompt          - user text (can be empty if a file is sent)
#   image           - base64‑encoded file (optional)
#   conversation_id - to maintain chat history (optional)
#   file_name       - original file name (optional, default "file.png")
#   _stream         - if true, SSE stream is returned (always true in this version)
# =====================================================================
@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    prompt = data.get("prompt", "").strip()
    image_base64 = data.get("image")
    conversation_id = data.get("conversation_id")
    file_name = data.get("file_name", "file.png")
    is_stream = data.get("_stream", False)

    # At least one of prompt or file must be provided
    if not prompt and not image_base64:
        return jsonify({"error": "Prompt or file cannot be empty"}), 400

    if is_stream:
        return Response(
            generate_stream(prompt, image_base64, conversation_id, file_name),
            mimetype="text/event-stream",
        )
    else:
        # Non‑streaming is disabled for simplicity; all requests use SSE
        return jsonify({"error": "Non-streaming mode temporarily disabled"}), 400


# =====================================================================
# Run the Flask development server
# Accessible only on localhost for security
# =====================================================================
if __name__ == "__main__":
    try:
        if USER_TOKEN:
            print(
                "Starting server on http://localhost:8000", file=sys.stderr, flush=True
            )
            print(
                "Keep this window open while using the extension.",
                file=sys.stderr,
                flush=True,
            )
            print(
                "Press Ctrl+C to stop the server and exit.", file=sys.stderr, flush=True
            )
            print(file=sys.stderr, flush=True)
            app.run(host="127.0.0.1", port=8000, debug=False, threaded=True)
        else:
            print(
                "\nThe server cannot start because no valid DeepSeek token was found.\n"
                "Please open token.txt with Notepad, paste your token, save, and restart this program.\n",
                file=sys.stderr,
                flush=True,
            )
            input("Press Enter to exit...")
    except Exception as e:
        import traceback

        print("\n" + "=" * 50, file=sys.stderr, flush=True)
        print("A fatal error occurred:", file=sys.stderr, flush=True)
        traceback.print_exc()
        print("=" * 50, file=sys.stderr, flush=True)
        print(
            "\nThe program cannot continue. Please check the error above and try again.",
            file=sys.stderr,
            flush=True,
        )
        input("Press Enter to exit...")
