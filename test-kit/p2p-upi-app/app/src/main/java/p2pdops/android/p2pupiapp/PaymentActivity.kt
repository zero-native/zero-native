package p2pdops.android.p2pupiapp

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class PaymentActivity : ComponentActivity() {

    private val TAG = "MockUPI-Payment"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uri: Uri? = intent.data
        val isViewAction = intent.action == Intent.ACTION_VIEW

        val payeeVpa = uri?.getQueryParameter("pa") ?: "merchant@upi"
        val payeeName = uri?.getQueryParameter("pn") ?: if (isViewAction) "Merchant" else "Self Test Merchant"
        val amount = uri?.getQueryParameter("am") ?: "500.00"
        val note = uri?.getQueryParameter("tn") ?: "Payment"
        val txnRef = uri?.getQueryParameter("tr") ?: "TRX_${System.currentTimeMillis()}"

        Log.i(TAG, "PaymentActivity opened (OPAQUE): pa=$payeeVpa, pn=$payeeName, am=$amount, tr=$txnRef")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                Log.i(TAG, "Hardware back pressed in PaymentActivity -> cancel")
                returnCancelled(txnRef)
            }
        })

        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = Color(0xFFF8FAFC)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        PaymentPromptCard(
                            payeeVpa = payeeVpa,
                            payeeName = payeeName,
                            amount = amount,
                            note = note,
                            onSuccess = { returnSuccess(txnRef) },
                            onFailure = { returnFailure(txnRef) },
                            onCancel = { returnCancelled(txnRef) },
                            onCrash = { simulateProcessCrash() }
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        // Test only: a link from an app that doesn't ask for a new task, like some UPI apps on return.
                        Text(
                            text = "Send a link to the app (no new task)",
                            color = Color(0xFF64748B),
                            modifier = Modifier
                                .clickable { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("zn://sample/offers?from=mock"))) }
                                .padding(12.dp)
                        )
                    }
                }
            }
        }
    }

    private fun returnSuccess(tr: String) {
        val timestamp = System.currentTimeMillis()
        val txnId = "MOCK$timestamp"
        val approvalRefNo = "APPR$timestamp"
        val responseStr = "txnId=$txnId&responseCode=00&ApprovalRefNo=$approvalRefNo&Status=SUCCESS&txnRef=$tr"

        Log.i(TAG, "Returning SUCCESS: $responseStr")

        val resultIntent = Intent().apply {
            putExtra("Status", "SUCCESS")
            putExtra("responseCode", "00")
            putExtra("txnId", txnId)
            putExtra("ApprovalRefNo", approvalRefNo)
            putExtra("txnRef", tr)
            putExtra("response", responseStr)
            data = Uri.parse("upi://pay?$responseStr")
        }
        setResult(Activity.RESULT_OK, resultIntent)
        finish()
    }

    private fun returnFailure(tr: String, reason: String = "ZM") {
        val timestamp = System.currentTimeMillis()
        val txnId = "MOCK$timestamp"
        val responseStr = "txnId=$txnId&responseCode=$reason&Status=FAILURE&txnRef=$tr"

        Log.i(TAG, "Returning FAILURE: $responseStr")

        val resultIntent = Intent().apply {
            putExtra("Status", "FAILURE")
            putExtra("responseCode", reason)
            putExtra("txnId", txnId)
            putExtra("txnRef", tr)
            putExtra("response", responseStr)
            data = Uri.parse("upi://pay?$responseStr")
        }
        setResult(Activity.RESULT_OK, resultIntent)
        finish()
    }

    private fun returnCancelled(tr: String) {
        val responseStr = "txnId=&responseCode=U69&Status=FAILURE&txnRef=$tr"

        Log.i(TAG, "Returning CANCELLED: $responseStr")

        val resultIntent = Intent().apply {
            putExtra("Status", "FAILURE")
            putExtra("responseCode", "U69")
            putExtra("txnRef", tr)
            putExtra("response", responseStr)
            data = Uri.parse("upi://pay?$responseStr")
        }
        setResult(Activity.RESULT_CANCELED, resultIntent)
        finish()
    }

    private fun simulateProcessCrash() {
        Log.e(TAG, "Simulating immediate process crash via SIGKILL")
        Process.killProcess(Process.myPid())
    }
}

