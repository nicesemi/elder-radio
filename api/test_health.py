from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/api/test-health")
async def test_health():
    import sys, os
    lib_dir = os.path.join(os.path.dirname(__file__), "_lib")
    files = os.listdir(lib_dir) if os.path.isdir(lib_dir) else ["NOT FOUND"]
    return {"status": "ok", "cwd": os.getcwd(), "lib_exists": os.path.isdir(lib_dir), "lib_files": files, "sys_path": sys.path[:5]}
