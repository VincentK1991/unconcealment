import type { APIRoute } from "astro";
import { getNormalizationPageData } from "../../../lib/normalization";

export const prerender = false;

const BACKEND_URL = import.meta.env.BACKEND_URL ?? "http://localhost:8080";
const PAGE_SIZE = 25;

export const GET: APIRoute = async ({ params, url }) => {
  const { dataset } = params;
  if (!dataset) {
    return new Response(JSON.stringify({ error: "Missing dataset" }), { status: 400 });
  }

  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) ? requestedPage : 1;
  const forceRefresh = url.searchParams.get("refresh") === "1";

  try {
    const data = await getNormalizationPageData({
      datasetId: dataset,
      backendUrl: BACKEND_URL,
      page,
      pageSize: PAGE_SIZE,
      forceRefresh,
    });

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[normalization api] failed to load:", error);
    return new Response(JSON.stringify({ error: "Backend unavailable" }), { status: 502 });
  }
};
