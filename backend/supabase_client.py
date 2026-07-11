import os
from functools import lru_cache

from supabase import create_client


def supabase_configured() -> bool:
    return bool(os.getenv("SUPABASE_URL") and supabase_key())


def supabase_key() -> str:
    return (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
        or ""
    ).strip()


@lru_cache(maxsize=1)
def get_supabase_client():
    url = os.getenv("SUPABASE_URL", "").strip()
    key = supabase_key()
    if not url or not key:
        raise RuntimeError("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(url, key)


def maybe_supabase_client():
    if not supabase_configured():
        return None
    return get_supabase_client()
