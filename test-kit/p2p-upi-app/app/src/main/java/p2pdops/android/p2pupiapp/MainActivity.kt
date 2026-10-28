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
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {

    private val TAG = "MockUPI"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Parse UPI intent parameters
        val uri: Uri? = intent.data
        val isViewAction = intent.action == Intent.ACTION_VIEW

        val payeeVpa = uri?.getQueryParameter("pa") ?: "merchant@upi"
        val payeeName = uri?.getQueryParameter("pn") ?: if (isViewAction) "Merchant" else "Self Test Merchant"
        val amount = uri?.getQueryParameter("am") ?: "500.00"
        val note = uri?.getQueryParameter("tn") ?: "Payment"
        val txnRef = uri?.getQueryParameter("tr") ?: "TRX_${System.currentTimeMillis()}"

        Log.i(TAG, "Opened with URI: $uri | pa=$payeeVpa, pn=$payeeName, am=$amount, tr=$txnRef")

        // Handle hardware back button to return user cancellation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                Log.i(TAG, "Hardware back pressed -> returning user cancel")
                returnCancelled(txnRef)
            }
        })

        setContent {
            MaterialTheme {
                LaunchedEffect(Unit) {
                    delay(1800)
                    val pIntent = Intent(this@MainActivity, PaymentActivity::class.java).apply {
                        data = this@MainActivity.intent.data
                        this@MainActivity.intent.extras?.let { putExtras(it) }
                        addFlags(Intent.FLAG_ACTIVITY_FORWARD_RESULT)
                    }
                    startActivity(pIntent)
                    finish()
                }

                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    LoadingCard(payeeName = payeeName, amount = amount)
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
        val txnId = "MOCK_FAIL_$timestamp"
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

@Composable
fun MockUpiScreen(
    payeeVpa: String,
    payeeName: String,
    amount: String,
    note: String,
    txnRef: String,
    onSuccess: () -> Unit,
    onFailure: () -> Unit,
    onCancel: () -> Unit,
    onCrash: () -> Unit
) {
    var isLoading by remember { mutableStateOf(true) }

    // PhonePe-style initial progress delay
    LaunchedEffect(Unit) {
        delay(1800)
        isLoading = false
    }

    // Outer container is transparent so the calling activity shows through the translucent window
    Box(
        modifier = Modifier
            .fillMaxSize()
            .clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() }
            ) {
                // Tapping outside the card dismisses with cancel
                if (!isLoading) onCancel()
            },
        contentAlignment = Alignment.Center
    ) {
        AnimatedVisibility(
            visible = isLoading,
            enter = fadeIn(animationSpec = tween(200)),
            exit = fadeOut(animationSpec = tween(200))
        ) {
            // Phase 1: Center circular progress bar over transparent window
            LoadingCard(payeeName = payeeName, amount = amount)
        }

        AnimatedVisibility(
            visible = !isLoading,
            enter = fadeIn(animationSpec = tween(300)) + scaleIn(initialScale = 0.95f),
            exit = fadeOut(animationSpec = tween(200))
        ) {
            // Phase 2: Interactive payment modal with response options
            PaymentPromptCard(
                payeeVpa = payeeVpa,
                payeeName = payeeName,
                amount = amount,
                note = note,
                onSuccess = onSuccess,
                onFailure = onFailure,
                onCancel = onCancel,
                onCrash = onCrash
            )
        }
    }
}

@Composable
fun LoadingCard(payeeName: String, amount: String) {
    Surface(
        modifier = Modifier
            .width(290.dp)
            .padding(16.dp),
        shape = RoundedCornerShape(24.dp),
        color = Color(0xFFFFFFFF),
        shadowElevation = 12.dp
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // Purple Brand Accent Circle
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .background(Color(0xFF5F259F), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "₹",
                    color = Color.White,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            Spacer(modifier = Modifier.height(18.dp))

            // PhonePe-style Circular Spinner
            CircularProgressIndicator(
                modifier = Modifier.size(38.dp),
                color = Color(0xFF5F259F),
                strokeWidth = 3.5.dp
            )

            Spacer(modifier = Modifier.height(18.dp))

            Text(
                text = "Connecting to UPI Gateway...",
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = Color(0xFF0F172A)
            )

            Spacer(modifier = Modifier.height(6.dp))

            Text(
                text = "Requesting ₹$amount for $payeeName",
                fontSize = 12.sp,
                color = Color(0xFF64748B),
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
fun PaymentPromptCard(
    payeeVpa: String,
    payeeName: String,
    amount: String,
    note: String,
    onSuccess: () -> Unit,
    onFailure: () -> Unit,
    onCancel: () -> Unit,
    onCrash: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth(0.92f)
            .padding(vertical = 24.dp)
            .clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() }
            ) { /* Consume clicks inside card */ },
        shape = RoundedCornerShape(24.dp),
        color = Color(0xFFFFFFFF),
        shadowElevation = 16.dp
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header Row: Brand badge & Title
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .background(Color(0xFFEDE9FE), CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "₹",
                            color = Color(0xFF5F259F),
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    Spacer(modifier = Modifier.width(10.dp))

                    Column {
                        Text(
                            text = "UPI Payment Request",
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFF0F172A)
                        )
                        Text(
                            text = "Mock UPI Gateway",
                            fontSize = 11.sp,
                            color = Color(0xFF64748B)
                        )
                    }
                }

                // Close Button
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .background(Color(0xFFF1F5F9), CircleShape)
                        .clickable { onCancel() },
                    contentAlignment = Alignment.Center
                ) {
                    Text(text = "✕", fontSize = 12.sp, color = Color(0xFF64748B), fontWeight = FontWeight.Bold)
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
            HorizontalDivider(color = Color(0xFFF1F5F9), thickness = 1.dp)
            Spacer(modifier = Modifier.height(16.dp))

            // Payee & Note Info Box
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFF8FAFC), RoundedCornerShape(14.dp))
                    .padding(14.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Text(text = "Paying To", fontSize = 11.sp, color = Color(0xFF94A3B8))
                        Text(
                            text = payeeName,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Color(0xFF0F172A)
                        )
                    }
                    Text(
                        text = payeeVpa,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = Color(0xFF5F259F),
                        modifier = Modifier
                            .background(Color(0xFFEDE9FE), RoundedCornerShape(6.dp))
                            .padding(horizontal = 8.dp, vertical = 4.dp)
                    )
                }

                if (note.isNotBlank()) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(text = "Note: $note", fontSize = 11.sp, color = Color(0xFF64748B))
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Amount Display
            Text(text = "Amount to Pay", fontSize = 12.sp, color = Color(0xFF64748B))
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = "₹$amount",
                fontSize = 32.sp,
                fontWeight = FontWeight.ExtraBold,
                color = Color(0xFF0F172A)
            )

            Spacer(modifier = Modifier.height(22.dp))

            // 1. Success Button (Emerald Green)
            Button(
                onClick = onSuccess,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF10B981),
                    contentColor = Color.White
                )
            ) {
                Text(
                    text = "Approve ₹$amount (Success)",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            Spacer(modifier = Modifier.height(10.dp))

            // 2. Decline Button (Soft Red)
            Button(
                onClick = onFailure,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFFFEE2E2),
                    contentColor = Color(0xFFDC2626)
                )
            ) {
                Text(
                    text = "Decline (Bank Failure)",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }

            Spacer(modifier = Modifier.height(10.dp))

            // 3. Bottom Row: Cancel & Crash options
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    onClick = onCancel,
                    modifier = Modifier
                        .weight(1f)
                        .height(40.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = Color(0xFF64748B)
                    )
                ) {
                    Text(text = "Cancel", fontSize = 12.sp, fontWeight = FontWeight.Medium)
                }

                Button(
                    onClick = onCrash,
                    modifier = Modifier
                        .weight(1f)
                        .height(40.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFFFEF3C7),
                        contentColor = Color(0xFFD97706)
                    )
                ) {
                    Text(text = "Simulate Crash", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
