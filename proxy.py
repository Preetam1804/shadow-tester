from fastapi import FastAPI, Request, Response, BackgroundTasks
import httpx
import json
app = FastAPI()

def scrub_data(data:dict)->dict:
    scrubbed={}
    sensitive_keys = {
    # Passwords
    "password", "passwd", "pwd", "pass", "user_password", "db_password",
    "hashed_password", "encrypted_password", "pin", "secret", "passcode",

    # Tokens / API Keys
    "auth_token", "token", "access_token", "refresh_token", "id_token",
    "jwt", "bearer_token", "api_key", "apikey", "key", "session_token",
    "oauth_token", "security_token",

    # Personal IDs
    "ssn", "social_security_number", "sin", "national_id", "nid",
    "aadhar", "aadhaar", "pan", "passport", "driver_license",
    "dl_number", "voter_id", "employee_id", "student_id",

    # Financial
    "credit_card", "card_number", "cc_number", "debit_card",
    "bank_account", "account_number", "iban", "routing_number",
    "swift_code", "cvv", "expiry_date",

    # Contact
    "email", "email_address", "phone", "phone_number", "mobile",
    "mobile_number", "contact_number", "address", "home_address",
    "billing_address", "shipping_address",

    # Other sensitive
    "dob", "date_of_birth", "birthdate", "gender", "mother_maiden_name",
    "security_question", "security_answer", "biometric_data",
    "fingerprint", "face_id"
    }

    for key,value in data.items():
        if key in sensitive_keys:
            scrubbed[key]="***MASKED***"
        elif isinstance(value,dict):
            scrubbed[key]=scrub_data(value);
        elif isinstance(value,list):
            new_list=[]
            for item in value:
                if isinstance(item,dict):
                    new_list.append(scrub_data(item))
                else:
                    new_list.append(item)
            scrubbed[key]=new_list
        else:
            scrubbed[key]=value;

    return scrubbed


async def send_to_v2(path: str, headers: dict, scrubbed_json: dict,v1_response_data: dict):
    v2_url = f"http://localhost:8002/{path}"
    headers.pop("content-length", None)
    headers.pop("Content-Length", None)
    # Open a dedicated, temporary client for this separate task
    async with httpx.AsyncClient() as client:
        try:
            response = await client.request(
                method="POST",
                url=v2_url,
                headers=headers,
                json=scrubbed_json 
            )
            print(f"Successfully mirrored traffic to V2. Response code: {response.status_code}")
        except Exception as e:
           
            print(f"Failed to send payload to V2: {e}")


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def interceptor(path: str, request: Request,background_tasks: BackgroundTasks):
    
    body_bytes = await request.body() 
    
    clean_headers = dict(request.headers)
    clean_headers.pop("host", None) 

    v1_url = f"http://localhost:8001/{path}"
    async with httpx.AsyncClient() as client:
        v1_response = await client.request(
            method=request.method,
            url=v1_url,
            headers=clean_headers, 
            content=body_bytes
        )


    if request.method in ["POST", "PUT"]:
        try:
            print("Attempting to queue background task...")
            body_dict = json.loads(body_bytes)
            safe_payload = scrub_data(body_dict)
            v1_dict=v1_response.json()
            # Add the task to the event loop pool
            background_tasks.add_task(send_to_v2, path, clean_headers, safe_payload,v1_dict)
            print("Background task successfully queued!")
        except json.JSONDecodeError:
            # If the request isn't JSON data, then don't break the proxy
            print(f"ERROR queueing shadow task: {repr(e)}")
            pass

    
    
    return Response(
        content=v1_response.content,
        status_code=v1_response.status_code,
        headers=dict(v1_response.headers)
    )