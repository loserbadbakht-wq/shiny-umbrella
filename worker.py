import os
import json
from bot import app, webhook

# ============= CLOUDFLARE WORKER HANDLER WITH KV =============
async def fetch(request, env):
    """Handle incoming requests to the Cloudflare Worker with KV storage"""
    
    # Store KV in the app context so handlers can access it
    app.bot.kv = env.KV
    
    # Handle webhook requests from Telegram
    if request.method == "POST":
        try:
            data = await request.json()
            
            # Process through the bot
            result = await webhook(request)
            
            return Response(
                json.dumps(result),
                status=200,
                headers={"Content-Type": "application/json"}
            )
        except Exception as e:
            return Response(
                json.dumps({"status": "error", "message": str(e)}),
                status=500,
                headers={"Content-Type": "application/json"}
            )
    
    # Handle GET requests (health checks)
    return Response(
        json.dumps({"status": "ok", "message": "Bot is active with persistent KV storage"}),
        status=200,
        headers={"Content-Type": "application/json"}
    )

# Export for Cloudflare Workers
async def fetch(request, env):
    return await fetch(request, env)
