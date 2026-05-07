// Cloudflare Workers SPA fallback handler
// Serves static assets directly, falls back to index.html for client-side routing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Skip SPA fallback for actual static files that exist
    // Cloudflare's ASSETS system handles this automatically
    try {
      const response = await env.ASSETS.fetch(request);
      // If the asset exists, serve it directly
      if (response.status !== 404) {
        return response;
      }
    } catch (e) {
      // Asset not found - continue to SPA fallback
    }
    
    // SPA fallback: serve index.html for all non-file routes
    const indexUrl = new URL('/index.html', url.origin);
    const indexResponse = await env.ASSETS.fetch(indexUrl);
    return new Response(indexResponse.body, {
      status: 200,
      headers: indexResponse.headers
    });
  }
};
