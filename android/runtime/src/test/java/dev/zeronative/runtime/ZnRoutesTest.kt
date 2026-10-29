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
