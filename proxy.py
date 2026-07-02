from fastapi import FastAPI, Request, Response
import httpx

app = FastAPI()
@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def interceptor(path: str, request: Request):
    
    body = await request.body() 
    v1_url = f"http://localhost:8001/{path}"
    
    # --- NEW FIX: Clean the headers ---
    clean_headers = dict(request.headers)
    clean_headers.pop("host", None) # Remove the 'host' header so httpx can generate a new one
    # ----------------------------------

    async with httpx.AsyncClient() as client:
        v1_response = await client.request(
            method=request.method,
            url=v1_url,
            headers=clean_headers, # Use our clean headers here!
            content=body
        )
    
    return Response(
        content=v1_response.content,
        status_code=v1_response.status_code,
        headers=dict(v1_response.headers)
    )