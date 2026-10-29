// Sample merchants. Plain data, no side effects (screens read it at runtime; step 2.4 replaces it with a long list).

export interface Merchant {
  id: string
  name: string
  area: string
  photo: string
}

export const MERCHANTS: Merchant[] = [
  { id: "m1", name: "Kalyan Jewellers", area: "Bannerghatta Road", photo: "https://picsum.photos/id/1062/112/112" },
  { id: "m2", name: "Sri Sai Medicals", area: "JP Nagar 7th Phase", photo: "https://picsum.photos/id/1080/112/112" },
  { id: "m3", name: "Annapoorna Tiffins", area: "Arekere", photo: "https://picsum.photos/id/292/112/112" },
  { id: "m4", name: "Green Leaf Supermart", area: "Hulimavu", photo: "https://picsum.photos/id/1059/112/112" },
  { id: "m5", name: "Ganesh Hardware", area: "Gottigere", photo: "https://picsum.photos/id/1067/112/112" },
]

/** The merchant for a route param. Unknown ids (an old link) get a neutral placeholder, never a crash. */
export function merchantById(id: string): Merchant {
  return MERCHANTS.find((m) => m.id === id) ?? { id, name: "Unknown merchant", area: "", photo: "" }
}
