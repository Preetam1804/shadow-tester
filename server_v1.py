from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

# This tells FastAPI what the incoming JSON should look like
class CheckoutRequest(BaseModel):
    item_name: str
    price: float
    user_id: int

@app.post("/checkout")
async def process_checkout(request: CheckoutRequest):
    # Pretend we are saving to a database here...
    
    # Return a V1 styled receipt
    return {
        "status": "success",
        "order_id": 999,
        "date": "2026-06-29",
        "total_paid": request.price
    }