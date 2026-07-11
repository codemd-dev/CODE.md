import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from urllib.parse import urlencode

import requests
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Serve everything inside ./static at /static
app.mount("/static", StaticFiles(directory="static"), name="static")

# Optional homepage
@app.get("/taskschat.html")
def taskschat():
    return FileResponse("static/taskschat.html")

@app.get("/privacy")
def privacy():
    return FileResponse("static/privacy.html")

@app.get("/privacy.html")
def privacy_html():
    return FileResponse("static/privacy.html")

@app.get("/terms")
def terms():
    return FileResponse("static/terms.html")

@app.get("/terms.html")
def terms_html():
    return FileResponse("static/terms.html")

# ============================================================
# CONFIG
# ============================================================

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")

GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", 
                                "https://api.finallydoneapp.com/oauth/google/callback")

# OLD https://taskschat.onrender.com/oauth/google/callback

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

SCOPES = [
    "https://www.googleapis.com/auth/tasks",
]

OAUTH_STATE_TTL_SECONDS = 3600  # Increased from 600 to 3600 seconds (1 hour)
OAUTH_STATE_SIGNING_KEY = os.getenv("OAUTH_STATE_SIGNING_KEY", GOOGLE_CLIENT_SECRET).encode("utf-8")

if not GOOGLE_CLIENT_ID:
    raise RuntimeError("Missing GOOGLE_CLIENT_ID")

if not GOOGLE_CLIENT_SECRET:
    raise RuntimeError("Missing GOOGLE_CLIENT_SECRET")

if not GOOGLE_REDIRECT_URI:
    raise RuntimeError("Missing GOOGLE_REDIRECT_URI")

# ============================================================
# IN-MEMORY STORAGE
# Replace with DB/Redis in production
# ============================================================

# Tracks Google OAuth state during the browser redirect flow
pending_states: dict[str, dict] = {}

# One-time auth codes that YOUR app issues to ChatGPT
chatgpt_auth_codes: dict[str, dict] = {}

# ChatGPT bearer tokens issued by YOUR app
chatgpt_access_tokens: dict[str, dict] = {}

# Optional refresh tokens for ChatGPT-side auth
chatgpt_refresh_tokens: dict[str, dict] = {}

# User store
users_by_id: dict[str, dict] = {}

# ============================================================
# HELPERS
# ============================================================

def now_ts() -> int:
    return int(time.time())


def _urlsafe_b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def create_signed_oauth_state(payload: dict) -> str:
    serialized = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(OAUTH_STATE_SIGNING_KEY, serialized, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(signature + serialized).decode("utf-8").rstrip("=")


def parse_signed_oauth_state(state: str) -> dict:
    try:
        raw = _urlsafe_b64decode(state)
    except Exception as exc:
        raise ValueError("Invalid OAuth state") from exc

    signature_size = hashlib.sha256().digest_size
    if len(raw) <= signature_size:
        raise ValueError("Invalid OAuth state")

    signature = raw[:signature_size]
    payload_bytes = raw[signature_size:]
    expected = hmac.new(OAUTH_STATE_SIGNING_KEY, payload_bytes, hashlib.sha256).digest()

    if not hmac.compare_digest(signature, expected):
        raise ValueError("Invalid OAuth state")

    return json.loads(payload_bytes.decode("utf-8"))


def create_user_with_google_tokens(google_token_data: dict) -> str:
    user_id = secrets.token_urlsafe(24)

    expires_in = int(google_token_data.get("expires_in", 3600))

    # Check if user already exists (optional improvement)
    existing_user = users_by_id.get(user_id)

    existing_refresh_token = None
    if existing_user:
        existing_refresh_token = existing_user.get("google_tokens", {}).get("refresh_token")

    refresh_token = google_token_data.get("refresh_token") or existing_refresh_token

    users_by_id[user_id] = {
        "id": user_id,
        "google_tokens": {
            "access_token": google_token_data["access_token"],
            "refresh_token": refresh_token,  # <-- FIX HERE
            "scope": google_token_data.get("scope"),
            "token_type": google_token_data.get("token_type", "Bearer"),
            "expires_at": now_ts() + expires_in - 60,
        },
        "created_at": now_ts(),
    }

    return user_id

def refresh_google_token(refresh_token: str) -> dict:
    resp = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )

    if not resp.ok:
        raise HTTPException(status_code=401, detail=f"Failed to refresh Google token: {resp.text}")

    return resp.json()


def get_current_user(authorization: str = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    access_token = authorization.split(" ", 1)[1]
    session = chatgpt_access_tokens.get(access_token)

    if not session:
        raise HTTPException(status_code=401, detail="Invalid access token")

    user_id = session["user_id"]
    user = users_by_id.get(user_id)

    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def get_valid_google_token(user: dict) -> str:
    token_data = user.get("google_tokens")
    if not token_data:
        raise HTTPException(status_code=401, detail="Google account not linked")

    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token")
    expires_at = token_data.get("expires_at", 0)

    if access_token and now_ts() < expires_at:
        return access_token

    if not refresh_token:
        raise HTTPException(status_code=401, detail="Google token expired and no refresh token is available")

    new_tokens = refresh_google_token(refresh_token)

    token_data["access_token"] = new_tokens["access_token"]
    token_data["expires_at"] = now_ts() + int(new_tokens.get("expires_in", 3600)) - 60

    if "refresh_token" in new_tokens:
        token_data["refresh_token"] = new_tokens["refresh_token"]

    return token_data["access_token"]


def get_google_token_for_request(user: dict = Depends(get_current_user)) -> str:
    return get_valid_google_token(user)


# ============================================================
# OAUTH START
# ChatGPT -> your app -> Google
# ============================================================

@app.get("/oauth/start")
def oauth_start(request: Request):

    print("=== /oauth/start ===")
    print("ALL QUERY PARAMS:", dict(request.query_params))

    chatgpt_redirect_uri = request.query_params.get("redirect_uri")
    chatgpt_state = request.query_params.get("state")

    print("chatgpt_redirect_uri:", chatgpt_redirect_uri)
    print("chatgpt_state:", chatgpt_state)

    # These come from ChatGPT's OAuth flow
    chatgpt_client_id = request.query_params.get("client_id")
    
    #chatgpt_redirect_uri = request.query_params.get("redirect_uri")
    #chatgpt_state = request.query_params.get("state")
    
    chatgpt_response_type = request.query_params.get("response_type")
    chatgpt_scope = request.query_params.get("scope")

    if not chatgpt_redirect_uri or not chatgpt_state:
        raise HTTPException(status_code=400, detail="Missing ChatGPT OAuth parameters")

    state_payload = {
        "created_at": now_ts(),
        "chatgpt_client_id": chatgpt_client_id,
        "chatgpt_redirect_uri": chatgpt_redirect_uri,
        "chatgpt_state": chatgpt_state,
        "chatgpt_response_type": chatgpt_response_type,
        "chatgpt_scope": chatgpt_scope,
    }

    google_state = create_signed_oauth_state(state_payload)
    pending_states[google_state] = state_payload

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": google_state,
    }

    auth_url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"

    print("STATE SENT TO GOOGLE Generated google_state:", google_state)
    print("Saved pending_states entry:", pending_states[google_state])
    print("GOOGLE Auth URL:", auth_url)

    return RedirectResponse(auth_url)


# ============================================================
# OAUTH CALLBACK
# Google -> your app -> ChatGPT
# ============================================================

@app.get("/oauth/google/callback")
def oauth_callback(code: str = None, state: str = None, error: str = None):
    print("=== /oauth/google/callback ===")
    
    print("=== CALLBACK ===")
    print("INSTANCE ID:", os.getpid())
    
    print("Incoming code:", code)
    print("Incoming state:", state)
    print("Incoming error:", error)
    print("Pending states keys:", list(pending_states.keys()))

    if error:
        raise HTTPException(status_code=400, detail=f"Google OAuth error: {error}")

    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")

    try:
        flow_data = parse_signed_oauth_state(state)
    except ValueError:
        print(f"ERROR: Invalid signed state '{state}'")
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    print("flow_data:", flow_data)

    state_age = now_ts() - flow_data["created_at"]
    print(f"State age: {state_age} seconds (TTL: {OAUTH_STATE_TTL_SECONDS})")
    if state_age > OAUTH_STATE_TTL_SECONDS:
        print(f"ERROR: State expired (age: {state_age}s > TTL: {OAUTH_STATE_TTL_SECONDS}s)")
        raise HTTPException(status_code=400, detail="Expired OAuth state")

    token_resp = requests.post(
        GOOGLE_TOKEN_URL,
        data={
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": GOOGLE_REDIRECT_URI,
        },
        timeout=30,
    )

    if not token_resp.ok:
        raise HTTPException(
            status_code=400,
            detail=f"Google token exchange failed: {token_resp.text}",
        )

    google_token_data = token_resp.json()
    user_id = create_user_with_google_tokens(google_token_data)

    app_auth_code = secrets.token_urlsafe(32)
    chatgpt_auth_codes[app_auth_code] = {
        "user_id": user_id,
        "created_at": now_ts(),
        "expires_at": now_ts() + 600,
    }

    ALLOWED_CHATGPT_REDIRECT_URIS = {
        "https://chat.openai.com/aip/g-44355378ae08e378cd25f869040f0ceafa921573/oauth/callback",
        "https://chatgpt.com/aip/g-44355378ae08e378cd25f869040f0ceafa921573/oauth/callback"
    }


    chatgpt_redirect_uri = flow_data["chatgpt_redirect_uri"]

    if chatgpt_redirect_uri not in ALLOWED_CHATGPT_REDIRECT_URIS:
        raise HTTPException(status_code=400, detail="Invalid redirect URI")

    redirect_params = {
        "code": app_auth_code,
        "state": flow_data["chatgpt_state"],
    }

    final_url = f"{chatgpt_redirect_uri}?{urlencode(redirect_params)}"

    print("chatgpt_redirect_uri:", flow_data.get("chatgpt_redirect_uri"))
    print("chatgpt_state:", flow_data.get("chatgpt_state"))
    print("FINAL REDIRECT URL:", final_url)

    return RedirectResponse(final_url)


#https://chat.openai.com/aip/g-c2f3eb674823b1e073325c15cd79161d8032df6c/oauth/callback

# ============================================================
# TOKEN EXCHANGE
# ChatGPT exchanges YOUR auth code for YOUR bearer token
# ============================================================

@app.post("/oauth/token")
async def oauth_token(request: Request):
    body = await request.body()
    content_type = request.headers.get("content-type", "")

    print("=== /oauth/token ===")
    print("TOKEN CONTENT-TYPE:", content_type)
    print("TOKEN RAW BODY:", body.decode("utf-8", errors="ignore"))
    print("INSTANCE ID:", os.getpid())
   

    # Parse either JSON or form-urlencoded
    if "application/json" in content_type:
        data = await request.json()
    else:
        form = await request.form()
        data = dict(form)

    grant_type = data.get("grant_type")
    code = data.get("code")
    incoming_refresh_token = data.get("refresh_token")

    print("grant_type:", grant_type)
    print("code:", code)
    print("incoming_refresh_token:", incoming_refresh_token)
    print("Available auth codes:", list(chatgpt_auth_codes.keys()))

    if grant_type == "authorization_code":
        if not code:
            raise HTTPException(status_code=400, detail="Missing authorization code")

        # Use get first so debugging is easier
        auth_record = chatgpt_auth_codes.get(code)

        if not auth_record:
            print("Invalid authorization code:", code)
            print("Known codes:", list(chatgpt_auth_codes.keys()))
            raise HTTPException(status_code=400, detail="Invalid authorization code")

        if auth_record["expires_at"] < now_ts():
            chatgpt_auth_codes.pop(code, None)
            raise HTTPException(status_code=400, detail="Authorization code expired")

        # Remove only after validation succeeds
        chatgpt_auth_codes.pop(code, None)

        user_id = auth_record["user_id"]

        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)

        chatgpt_access_tokens[access_token] = {
            "user_id": user_id,
            "created_at": now_ts(),
            "expires_at": now_ts() + 3600,
            "refresh_token": refresh_token,
        }

        chatgpt_refresh_tokens[refresh_token] = {
            "user_id": user_id,
            "created_at": now_ts(),
        }

        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": refresh_token,
        }

    if grant_type == "refresh_token":
        if not incoming_refresh_token:
            raise HTTPException(status_code=400, detail="Missing refresh token")

        refresh_record = chatgpt_refresh_tokens.get(incoming_refresh_token)

        if not refresh_record:
            raise HTTPException(status_code=400, detail="Invalid refresh token")

        user_id = refresh_record["user_id"]
        access_token = secrets.token_urlsafe(32)

        chatgpt_access_tokens[access_token] = {
            "user_id": user_id,
            "created_at": now_ts(),
            "expires_at": now_ts() + 3600,
            "refresh_token": incoming_refresh_token,
        }

        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": incoming_refresh_token,
        }

    raise HTTPException(
        status_code=400,
        detail=f"Unsupported grant_type: {grant_type}"
    )


# ============================================================
# DEBUG ENDPOINT - Remove in production
# ============================================================

@app.get("/debug/pending-states")
def debug_pending_states():
    """Debug endpoint to check current pending OAuth states"""
    return {
        "count": len(pending_states),
        "states": list(pending_states.keys()),
        "details": {
            state: {
                "created_at": data["created_at"],
                "age_seconds": now_ts() - data["created_at"],
                "chatgpt_redirect_uri": data.get("chatgpt_redirect_uri"),
            }
            for state, data in pending_states.items()
        }
    }

@app.get("/list-task-lists")
def list_task_lists(google_token: str = Depends(get_google_token_for_request)):
    all_task_lists = []
    page_token = None
    max_results = 100  # Fetch up to 100 task lists per page

    while True:
        params = {"maxResults": max_results}
        if page_token:
            params["pageToken"] = page_token

        r = requests.get(
            "https://tasks.googleapis.com/tasks/v1/users/@me/lists",
            headers={"Authorization": f"Bearer {google_token}"},
            params=params,
            timeout=30,
        )

        if r.status_code == 401:
            raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")

        if not r.ok:
            raise HTTPException(status_code=r.status_code, detail=r.text)

        response_data = r.json()

        # Add task lists from this page
        if "items" in response_data:
            all_task_lists.extend(response_data["items"])

        # Check if there are more pages
        page_token = response_data.get("nextPageToken")
        if not page_token:
            break

    # Return combined results
    return {
        "items": all_task_lists,
        "kind": "tasks#taskLists",
        "totalItems": len(all_task_lists)
    }


@app.get("/list-tasks")
def list_tasks(
    listId: str = "@default",
    google_token: str = Depends(get_google_token_for_request),
):
    all_tasks = []
    page_token = None
    max_results = 100  # Fetch up to 100 tasks per page to reduce API calls
    page_count = 0

    while True:
        page_count += 1
        params = {"maxResults": max_results}
        if page_token:
            params["pageToken"] = page_token

        print(f"DEBUG: Fetching page {page_count} with params: {params}")

        r = requests.get(
            f"https://tasks.googleapis.com/tasks/v1/lists/{listId}/tasks",
            headers={"Authorization": f"Bearer {google_token}"},
            params=params,
            timeout=30,
        )

        if r.status_code == 401:
            raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")

        if not r.ok:
            raise HTTPException(status_code=r.status_code, detail=r.text)

        response_data = r.json()
        items_count = len(response_data.get("items", []))
        next_token = response_data.get("nextPageToken", "None")
        print(f"DEBUG: Page {page_count} response: {items_count} items, nextPageToken: {next_token}")

        # Add tasks from this page
        if "items" in response_data:
            all_tasks.extend(response_data["items"])

        # Check if there are more pages
        page_token = response_data.get("nextPageToken")
        if not page_token:
            print(f"DEBUG: No more pages after page {page_count}")
            break

    print(f"DEBUG: Total tasks collected: {len(all_tasks)}")

    # Return combined results
    return {
        "items": all_tasks,
        "kind": "tasks#tasks",
        "totalItems": len(all_tasks)
    }


@app.post("/create-task")
async def create_task(
    title: str,
    notes: str | None = None,
    due: str | None = None,
    listId: str = "@default",
    google_token: str = Depends(get_google_token_for_request),
):
    # Build the Google Tasks API body
    body = {"title": title}
    if notes:
        body["notes"] = notes
    if due:
        body["due"] = due
    r = requests.post(
        f"https://tasks.googleapis.com/tasks/v1/lists/{listId}/tasks",
        headers={
            "Authorization": f"Bearer {google_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=30,
    )
    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")
    if not r.ok:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()


@app.post("/update-task/{task_id}")
async def update_task(
    task_id: str,
    title: str | None = None,
    notes: str | None = None,
    due: str | None = None,
    listId: str = "@default",
    google_token: str = Depends(get_google_token_for_request),
):
    # Build the Google Tasks update body
    body = {}
    if title is not None:
        body["title"] = title
    if notes is not None:
        body["notes"] = notes
    if due is not None:
        body["due"] = due
    r = requests.patch(
        f"https://tasks.googleapis.com/tasks/v1/lists/{listId}/tasks/{task_id}",
        headers={
            "Authorization": f"Bearer {google_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=30,
    )
    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")
    if not r.ok:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()


@app.post("/complete-task/{task_id}")
def complete_task(
    task_id: str,
    listId: str = "@default",
    google_token: str = Depends(get_google_token_for_request),
):
    body = {
        "status": "completed",
        "completed": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }

    r = requests.patch(
        f"https://tasks.googleapis.com/tasks/v1/lists/{listId}/tasks/{task_id}",
        headers={
            "Authorization": f"Bearer {google_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=30,
    )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")

    if not r.ok:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()


@app.post("/uncomplete-task/{task_id}")
def uncomplete_task(
    task_id: str,
    listId: str = "@default",
    google_token: str = Depends(get_google_token_for_request),
):
    body = {
        "status": "needsAction",
        "completed": None,
    }

    r = requests.patch(
        f"https://tasks.googleapis.com/tasks/v1/lists/{listId}/tasks/{task_id}",
        headers={
            "Authorization": f"Bearer {google_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=30,
    )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")

    if not r.ok:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()



# PSTOD Don't allow task deletion
#@app.delete("/delete-task/{task_id}")
#def delete_task(
#    task_id: str,
#    listId: str = "@default",
#    google_token: str = Depends(get_google_token_for_request),
#):
#    r = requests.delete(
#        f"https://tasks.googleapis.com/tasks/v1/lists/{listId}/tasks/{task_id}",
#        headers={"Authorization": f"Bearer {google_token}"},
#        timeout=30,
#    )
#    if r.status_code == 401:
#        raise HTTPException(status_code=401, detail="Google OAuth token is missing or expired")
#   if r.status_code not in (200, 204):
#        raise HTTPException(status_code=r.status_code, detail=r.text)
#    return {"success": True, "task_id": task_id}
