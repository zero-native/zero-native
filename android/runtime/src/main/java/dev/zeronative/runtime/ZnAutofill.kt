package dev.zeronative.runtime

import androidx.compose.ui.autofill.ContentType

/**
 * RN autoComplete (registry 17, enum order in registry.ts) → the Android autofill hint, which the keyboard and the
 * phone's autofill service read to offer the phone number, an SMS code, an email. "off" (0): no hint.
 */
internal fun autofillHint(v: Int): ContentType? = when (v) {
    Registry.AutoComplete.TEL -> ContentType.PhoneNumber
    Registry.AutoComplete.TEL_NATIONAL -> ContentType.PhoneNumberNational
    Registry.AutoComplete.TEL_COUNTRY_CODE -> ContentType.PhoneCountryCode
    Registry.AutoComplete.TEL_DEVICE -> ContentType.PhoneNumberDevice
    Registry.AutoComplete.SMS_OTP -> ContentType.SmsOtpCode
    Registry.AutoComplete.EMAIL -> ContentType.EmailAddress
    Registry.AutoComplete.NAME -> ContentType.PersonFullName
    Registry.AutoComplete.GIVEN_NAME -> ContentType.PersonFirstName
    Registry.AutoComplete.FAMILY_NAME -> ContentType.PersonLastName
    Registry.AutoComplete.NAME_MIDDLE -> ContentType.PersonMiddleName
    Registry.AutoComplete.USERNAME -> ContentType.Username
    Registry.AutoComplete.USERNAME_NEW -> ContentType.NewUsername
    Registry.AutoComplete.PASSWORD -> ContentType.Password
    Registry.AutoComplete.NEW_PASSWORD -> ContentType.NewPassword
    Registry.AutoComplete.POSTAL_CODE -> ContentType.PostalCode
    Registry.AutoComplete.STREET_ADDRESS -> ContentType.AddressStreet
    Registry.AutoComplete.POSTAL_ADDRESS -> ContentType.PostalAddress
    Registry.AutoComplete.COUNTRY -> ContentType.AddressCountry
    Registry.AutoComplete.BIRTHDATE_FULL -> ContentType.BirthDateFull
    Registry.AutoComplete.GENDER -> ContentType.Gender
    else -> null
}
