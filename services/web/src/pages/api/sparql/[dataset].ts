import type { APIRoute } from "astro";

export const prerender = false;

const BACKEND_URL = import.meta.env.BACKEND_URL ?? "http://localhost:8080";

export const POST: APIRoute = async ({ params, request }) => {
  const { dataset } = params;
  if (!dataset) {
    return new Response("Missing dataset", { status: 400 });
  }

  const body = await request.text();
  if (!body) {
    return new Response("Missing SPARQL query body", { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${BACKEND_URL}/query/raw?dataset=${encodeURIComponent(dataset)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/sparql-query" },
        body,
      }
    );

    const responseBody = await upstream.text();

    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (e) {
    console.error("[sparql proxy] backend unreachable:", e);
    return new Response("Backend unavailable", { status: 502 });
  }
};
