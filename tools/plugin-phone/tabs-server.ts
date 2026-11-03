// Fake data for the tabs lab (examples/sample/src/TabsLab.tsx): GET /tabs/<tab>?ms=<delay>&rows=<n>. Served by
// tools/fetch-test-server.ts (port 8788), or by the tabs phone steps when that server isn't running.

/** One tab's answer, about the size of a real home tab's. */
export function tabsData(tab: string, rows: number) {
  return {
    tab,
    items: Array.from({ length: rows }, (_, i) => ({
      id: `${tab}-${i}`,
      title: `${tab[0].toUpperCase()}${tab.slice(1)} item ${i + 1}`,
      subtitle: i % 3 === 0 ? "Koramangala, Bengaluru · 1.2 km" : "Cashback up to 5% · today",
      amount: 40 + ((i * 137) % 960),
    })),
  }
}

/** The answer for a /tabs/ request, after its delay; null for any other path. */
export async function tabsAnswer(url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/tabs/")) return null
  const rows = Number(url.searchParams.get("rows") ?? 40)
  await Bun.sleep(Number(url.searchParams.get("ms") ?? 300))
  return Response.json(tabsData(url.pathname.slice("/tabs/".length), rows))
}
