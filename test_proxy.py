import httpx

# The exact data Server 1 is expecting
payload = {
    "item_name": "Mechanical Keyboard",
    "price": 120.50,
    "user_id": 42,
    "credit_card":"4111-2222-3333-4444"
}

print("Sending request to our Middleman Proxy (Port 8000)...")

# We send it to 8000, NOT 8001!
response = httpx.post("http://localhost:8000/checkout", json=payload)

print(f"Status Code: {response.status_code}")
try:
    print(f"Response Body: {response.content}")
except:
    print(f"Failed to parse JSON. Raw text: {response.text}")