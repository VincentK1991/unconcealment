import type { APIRoute } from "astro";

export const prerender = false;

const BACKEND_URL = import.meta.env.BACKEND_URL ?? "http://localhost:8080";

export const POST: APIRoute = async ({ params, request }) => {
  const { dataset } = params;
  if (!dataset) {
    return new Response(JSON.stringify({ error: "Missing dataset" }), { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).query !== "string"
  ) {
    return new Response(JSON.stringify({ error: "Body must include { rules, query }" }), { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${BACKEND_URL}/query/playground?dataset=${encodeURIComponent(dataset)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[reasoning proxy] backend unreachable:", e);
    return new Response(JSON.stringify({ error: "Backend unavailable" }), { status: 502 });
  }
};
