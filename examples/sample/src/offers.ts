// Offers feed data for the sample (milestone 2 step 2.4): test-kit/offers-data.json is a real list of offers (shape:
// `OfferData` in the ZeroBill RN app's backend/offersService.ts). It has no subsections, so they are made here the way
// the backend does: banners together, product offers per merchant (zmc), message offers one card per row.
// No side effects: the feed is built when the screen opens.
import rawOffers from "../../../test-kit/offers-data.json"

export interface Offer {
  id: string
  zmc: string | null
  type: "BANNER" | "PRODUCT" | "MESSAGE" | string
  source_name: string | null
  tagline: string | null
  caption: string | null
  description: string | null
  product_details: { name?: string; image_url?: string } | null
  /** Not in today's test-kit export; the live API has it. */
  image_id?: string | null
}

const OFFER_IMAGE_BASE = "https://storage.googleapis.com/my-gcp-project.appspot.com/"

/** The offer's image URL, as the RN app builds it (BannerCard / MerchantProductSection), or null. */
export function offerImage(o: Offer): string | null {
  if (o.product_details?.image_url) return o.product_details.image_url
  if (!o.image_id) return null
  return String(o.image_id).startsWith("http") ? o.image_id : `${OFFER_IMAGE_BASE}${o.image_id}`
}

export type FeedItem =
  | { kind: "header"; id: string; title: string }
  | { kind: "banners"; id: string; offers: Offer[] }
  | { kind: "products"; id: string; merchant: string; caption: string; offers: Offer[] }
  | { kind: "message"; id: string; offer: Offer }

/** The text a card shows as its main line. */
export function offerTitle(o: Offer): string {
  return o.product_details?.name || o.caption || o.tagline || o.source_name || "Special offer"
}

/**
 * The feed: "Top offers" (one banner rail), "Nearby shop offers" (a product rail per merchant), "More deals" (a card
 * per message offer). `copies` repeats it (with unique ids) to make a long feed for scroll tests.
 */
export function buildOffersFeed(copies = 1): FeedItem[] {
  const offers = rawOffers as Offer[]
  const banners = offers.filter((o) => o.type === "BANNER")
  const messages = offers.filter((o) => o.type === "MESSAGE")
  const byMerchant = new Map<string, Offer[]>()
  for (const o of offers) {
    if (o.type !== "PRODUCT") continue
    const k = String(o.zmc ?? "none")
    byMerchant.set(k, [...(byMerchant.get(k) ?? []), o])
  }

  const feed: FeedItem[] = []
  for (let n = 0; n < copies; n++) {
    const id = (s: string) => `${n}-${s}`
    const copy = <T extends Offer>(list: T[]) => (n === 0 ? list : list.map((o) => ({ ...o, id: `${n}-${o.id}` })))
    if (banners.length > 0) {
      feed.push({ kind: "header", id: id("h-top"), title: "Top offers for you" })
      feed.push({ kind: "banners", id: id("banners"), offers: copy(banners) })
    }
    if (byMerchant.size > 0) feed.push({ kind: "header", id: id("h-shops"), title: "Nearby shop offers" })
    for (const [zmc, list] of byMerchant) {
      feed.push({
        kind: "products",
        id: id(`p-${zmc}`),
        merchant: list[0].source_name || "Local store",
        caption: `${list.length} offers`,
        offers: copy(list),
      })
    }
    if (messages.length > 0) feed.push({ kind: "header", id: id("h-more"), title: "More deals" })
    for (const o of copy(messages)) feed.push({ kind: "message", id: id(`m-${o.id}`), offer: o })
  }
  return feed
}
