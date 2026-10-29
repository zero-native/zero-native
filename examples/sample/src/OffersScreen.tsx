// An offers feed shaped like ZeroBill's RN HomeOffersTab (milestone 2 step 2.4): section headers, a banner rail,
// one product rail per merchant, message cards. One <List> with 4 row kinds; rails are <Scroll horizontal> with
// .map inside a row, so scrolling a rail never involves JS. Data: test-kit/offers-data.json (via offers.ts).
import { Box, Carousel, Column, Icon, Image, List, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { nav, signal, useImpressions } from "@zero-native/core"
import { c } from "./tokens"
import { chevronRight, shoppingBag, tag } from "./icons"
import { buildOffersFeed, offerImage, offerTitle, type FeedItem, type Offer } from "./offers"

const COPIES = 10 // the real feed repeated (unique ids) for a long scroll test

const open = (o: Offer) => console.info(`offers: tap ${o.id}`)

function SectionHeader(props: { title: string }) {
  return (
    <Text fontSize={16} fontWeight={800} color={c.ink} style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 }}>
      {props.title}
    </Text>
  )
}

function BannerCard(props: { o: Offer }) {
  const image = offerImage(props.o)
  if (image) {
    // Image banner: the photo with a dark gradient from the bottom, so the white text stays readable.
    return (
      <Pressable impressionKey={props.o.id} onPress={() => open(props.o)} style={{ width: 300, height: 160, borderRadius: 16, elevation: 3, overflow: "hidden" }}>
        <Stack style={{ width: 300, height: 160 }}>
          <Image src={image} style={{ width: 300, height: 160 }} />
          <Column
            justifyContent="flex-end"
            style={{
              position: "absolute",
              top: 0,
              start: 0,
              width: 300,
              height: 160,
              padding: 16,
              gap: 2,
              backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.85) 100%)",
            }}
          >
            <Text fontSize={10} fontWeight={600} color="#6EE7B7" numberOfLines={1}>
              {props.o.source_name}
            </Text>
            <Text fontSize={14} fontWeight={900} color={c.white} numberOfLines={2}>
              {offerTitle(props.o)}
            </Text>
          </Column>
        </Stack>
      </Pressable>
    )
  }
  return (
    <Pressable
      impressionKey={props.o.id} onPress={() => open(props.o)}
      style={{
        width: 300,
        height: 160,
        borderRadius: 16,
        padding: 16,
        elevation: 3,
        backgroundImage: "linear-gradient(135deg, #047857 0%, #115E59 55%, #0F172A 100%)",
      }}
      justifyContent="space-between"
    >
      <Row style={{ alignItems: "center" }}>
        <Box style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.2)" }}>
          <Text fontSize={11} fontWeight={700} color={c.white} numberOfLines={1}>
            {props.o.tagline || "SPECIAL OFFER"}
          </Text>
        </Box>
      </Row>
      <Column style={{ gap: 2 }}>
        <Text fontSize={11} fontWeight={600} color="#A7F3D0" numberOfLines={1}>
          {props.o.source_name}
        </Text>
        <Text fontSize={16} fontWeight={800} color={c.white} numberOfLines={2}>
          {offerTitle(props.o)}
        </Text>
      </Column>
      <Row style={{ alignItems: "center", justifyContent: "space-between" }}>
        <Text fontSize={11} color="#A7F3D0">
          Tap to view &amp; redeem
        </Text>
        <Row style={{ alignItems: "center", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.2)" }}>
          <Text fontSize={12} fontWeight={700} color={c.white}>
            Claim
          </Text>
          <Icon icon={chevronRight} color={c.white} style={{ width: 14, height: 14 }} />
        </Row>
      </Row>
    </Pressable>
  )
}

/** Banners: a native carousel (snap, next banner peeks, auto-advance every 4.5 s, dots), like the RN BannerCarousel
 *  but without its JS timer and re-render per page. */
function BannerRail(props: { offers: Offer[] }) {
  return (
    <Carousel
      itemWidth={300}
      autoAdvance={4500}
      dots
      onPageChange={(i) => console.info(`offers: banner page ${i}`)}
      style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 6 }}
    >
      {props.offers.map((o) => (
        <BannerCard key={o.id} o={o} />
      ))}
    </Carousel>
  )
}

function ProductCard(props: { o: Offer }) {
  return (
    <Pressable
      impressionKey={props.o.id} onPress={() => open(props.o)}
      style={{ width: 176, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.white, overflow: "hidden" }}
    >
      <Box alignItems="center" justifyContent="center" style={{ height: 128, backgroundColor: "#F3F4F6" }}>
        {offerImage(props.o) ? (
          <Image src={offerImage(props.o)} contentScale="contain" style={{ width: 152, height: 98 }} />
        ) : (
          <Icon icon={shoppingBag} color="#9CA3AF" style={{ width: 40, height: 40 }} />
        )}
      </Box>
      <Column style={{ padding: 12, gap: 8 }}>
        <Text fontSize={12} fontWeight={700} color={c.ink} numberOfLines={2}>
          {offerTitle(props.o)}
        </Text>
        {props.o.tagline && (
          <Box style={{ paddingVertical: 2, backgroundColor: "#047857" }} alignItems="center">
            <Text fontSize={9} fontWeight={800} color={c.white} numberOfLines={1}>
              {props.o.tagline}
            </Text>
          </Box>
        )}
      </Column>
    </Pressable>
  )
}

function ProductRail(props: { merchant: string; caption: string; offers: Offer[] }) {
  return (
    <Column style={{ paddingVertical: 12, gap: 12 }}>
      <Row style={{ paddingHorizontal: 16, gap: 8, alignItems: "center" }}>
        <Box alignItems="center" justifyContent="center" style={{ width: 32, height: 32, borderRadius: 12, backgroundColor: "#FAF5FF" }}>
          <Icon icon={shoppingBag} color="#7E22CE" style={{ width: 16, height: 16 }} />
        </Box>
        <Column style={{ flex: 1 }}>
          <Text fontSize={14} fontWeight={700} color={c.ink} numberOfLines={1}>
            {props.merchant}
          </Text>
          <Text fontSize={11} fontWeight={600} color="#059669">
            {props.caption}
          </Text>
        </Column>
        <Text fontSize={12} fontWeight={700} color="#047857">
          View All
        </Text>
      </Row>
      <Scroll horizontal style={{ gap: 12, paddingHorizontal: 16 }}>
        {props.offers.map((o) => (
          <ProductCard key={o.id} o={o} />
        ))}
      </Scroll>
    </Column>
  )
}

function MessageCard(props: { o: Offer }) {
  return (
    <Pressable
      impressionKey={props.o.id} onPress={() => open(props.o)}
      style={{ marginHorizontal: 16, padding: 12, gap: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.white }}
    >
      <Row style={{ gap: 12, alignItems: "center" }}>
        <Box alignItems="center" justifyContent="center" style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: "#FEF3C7" }}>
          <Icon icon={tag} color="#B45309" style={{ width: 18, height: 18 }} />
        </Box>
        <Column style={{ flex: 1, gap: 2 }}>
          <Text fontSize={11} color={c.muted} numberOfLines={1}>
            {props.o.source_name}
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink} numberOfLines={2}>
            {offerTitle(props.o)}
          </Text>
        </Column>
        <Box alignItems="center" justifyContent="center" style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#F3F4F6" }}>
          <Icon icon={chevronRight} color={c.muted} style={{ width: 16, height: 16 }} />
        </Box>
      </Row>
    </Pressable>
  )
}

export function OffersScreen() {
  const feed = signal<FeedItem[]>(buildOffersFeed(COPIES))
  // Each card counts once per visit when 35 % of it is visible (the RN app's rule); native measures, JS gets batches.
  let seen = 0
  useImpressions((keys) => {
    seen += keys.length
    console.info(`offers: impressions +${keys.length} (total ${seen}): ${keys.slice(0, 3).join(", ")}`)
  })
  return (
    <Column style={{ flex: 1, backgroundColor: c.white }}>
      <Row style={{ paddingHorizontal: 8, paddingVertical: 8, gap: 4, alignItems: "center", borderBottomWidth: 1, borderColor: c.border }}>
        <Pressable onPress={() => nav.back()} alignItems="center" justifyContent="center" style={{ width: 40, height: 40, borderRadius: 20 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={18} fontWeight={700} color={c.ink}>
          Offers
        </Text>
      </Row>
      <List
        data={feed()}
        key={(f) => f.id}
        style={{ flex: 1 }}
        gap={8}
        row={(f) =>
          f.kind === "header" ? <SectionHeader title={f.title} />
          : f.kind === "banners" ? <BannerRail offers={f.offers} />
          : f.kind === "products" ? <ProductRail merchant={f.merchant} caption={f.caption} offers={f.offers} />
          : <MessageCard o={f.offer} />
        }
      />
    </Column>
  )
}
