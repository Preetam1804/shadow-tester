from fastapi import FastAPI
from pydantic import BaseModel
from datetime import datetime

app = FastAPI()

class CheckoutRequest(BaseModel):
    item_name: str
    price: float
    user_id: int

@app.post("/checkout")
async def process_checkout(request: CheckoutRequest):
    # Return a V2 styled receipt (Notice the different keys!)
    return {
        "status": "success",
        "orderId": 999, # Changed from order_id
        "timestamp": datetime.now().isoformat(), # Changed from date
        "total_paid": request.price
    }