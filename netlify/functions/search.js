// netlify/functions/search.js
export async function handler(event, context) {
  try {
    const params = event.queryStringParameters;
    const q = (params.q || "").trim();
    if (!q) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing query param q" }) };
    }

    const query = `(${q} OR $${q} OR #${q}) -is:retweet`;
    const url = new URL("https://api.twitter.com/2/tweets/search/recent");
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", "20");
    url.searchParams.set("tweet.fields", "author_id,public_metrics,created_at,entities");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username,name,profile_image_url,description,public_metrics");

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    });
    const data = await r.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "server_error" }) };
  }
}
