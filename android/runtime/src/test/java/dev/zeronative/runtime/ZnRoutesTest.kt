package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ZnRoutesTest {
    private fun route(index: Int, name: String, path: String, deepLink: Boolean = true) =
        ZnRoute(index, name, path, templateId = index, ZnRoute.Transition.PUSH, true, true, true, deepLink)

    private val routes = ZnRoutes(
        listOf(
            route(0, "home", "/"),
            route(1, "amount", "/pay/:merchantId"),
            route(2, "newPay", "/pay/new"),
            route(3, "tab", "/pay/:merchantId/:tab"),
            route(4, "secret", "/admin/:id", deepLink = false),
        ),
    )

    @Test
    fun aTabLinkOpensItsScreenWithTheTab() {
        fun tabbed(index: Int, name: String, path: String, tabs: List<String>, deepLink: Boolean = true) =
            ZnRoute(index, name, path, index, ZnRoute.Transition.PUSH, true, true, true, deepLink, tabs = tabs)
        val r = ZnRoutes(
            listOf(
                tabbed(0, "home", "/", listOf("pay", "stores")),
                route(1, "offers", "/offers"),
                tabbed(2, "shop", "/shop/:id", listOf("menu", "reviews")),
                tabbed(3, "quiet", "/quiet", listOf("a", "b"), deepLink = false),
            ),
        )
        assertEquals(ZnRouteMatch(r.named("home")!!, mapOf("tab" to "stores")), r.matchDeepLink("/stores"))
        assertEquals(ZnRouteMatch(r.named("home")!!, emptyMap()), r.matchDeepLink("/")) // the screen itself still matches
        assertEquals("offers", r.matchDeepLink("/offers")?.route?.name) // not a tab: an ordinary route
        assertEquals(mapOf("id" to "s 1", "tab" to "reviews"), r.matchDeepLink("/shop/s%201/reviews")?.params)
        assertEquals(mapOf("id" to "s1"), r.matchDeepLink("/shop/s1")?.params)
        assertNull(r.matchDeepLink("/shop/s1/photos")) // not one of its tabs
        assertNull(r.matchDeepLink("/quiet/a")) // no deepLink: its tabs can't be linked either
    }

    @Test
    fun lookups() {
        assertEquals("amount", routes.named("amount")?.name)
        assertEquals("tab", routes.at(3)?.name)
        assertEquals("home", routes.start?.name)
        assertNull(routes.named("missing"))
        assertNull(routes.at(9))
    }

    @Test
    fun matchesParamsAndRoot() {
        assertEquals(ZnRouteMatch(routes.named("amount")!!, mapOf("merchantId" to "m1")), routes.matchDeepLink("/pay/m1"))
        assertEquals(mapOf("merchantId" to "m1", "tab" to "upi"), routes.matchDeepLink("/pay/m1/upi")?.params)
        assertEquals("home", routes.matchDeepLink("/")?.route?.name)
        assertEquals("home", routes.matchDeepLink("")?.route?.name)
        // Trailing slash, query and fragment are ignored.
        assertEquals("m1", routes.matchDeepLink("/pay/m1/?utm=x#top")?.params?.get("merchantId"))
    }

    @Test
    fun literalBeatsParam() {
        assertEquals("newPay", routes.matchDeepLink("/pay/new")?.route?.name)
    }

    @Test
    fun noMatch() {
        assertNull(routes.matchDeepLink("/pay"))
        assertNull(routes.matchDeepLink("/pay/m1/upi/extra"))
        assertNull(routes.matchDeepLink("/other/m1"))
        // Routes without deepLink can't be opened from a link.
        assertNull(routes.matchDeepLink("/admin/1"))
    }

    @Test
    fun decodesParams() {
        assertEquals("Kalyan Jewellers", routes.matchDeepLink("/pay/Kalyan%20Jewellers")?.params?.get("merchantId"))
        assertEquals("a+b", routes.matchDeepLink("/pay/a+b")?.params?.get("merchantId"))
        assertEquals("₹", routes.matchDeepLink("/pay/%E2%82%B9")?.params?.get("merchantId"))
        // Malformed escapes and invalid UTF-8 don't match.
        assertNull(routes.matchDeepLink("/pay/%2"))
        assertNull(routes.matchDeepLink("/pay/%ZZ"))
        assertNull(routes.matchDeepLink("/pay/%C3%28"))
    }
}
