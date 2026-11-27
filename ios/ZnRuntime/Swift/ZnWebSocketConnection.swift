// One WebSocket connection for ZnWebSocket, on NWConnection (TCP, and TLS for wss://) with our own handshake and
// frames (ZnWebSocketWire.swift). Everything runs on the queue it is given, and every callback comes on it.
// ZnWebSocket keeps the JS rules (events, pings, limits, timers); this only moves bytes. Foundation, Network and
// Security only, so the Mac tests (ios/tests/websocket) run it against a real socket.
//
// Each read is handed to the reader before its end-of-stream is looked at, so the messages and the close frame that
// came in the same read as the server's FIN all arrive, in order (URLSessionWebSocketTask lost them: see the wire file).
import Foundation
import Network
import Security

final class ZnWsConnection {
    /// The handshake answered 101 and passed its checks: the protocol the server chose ("" for none).
    var onOpen: ((String) -> Void)?
    /// Each message and control frame from the server, in order.
    var onEvent: ((ZnWsEvent) -> Void)?
    /// The connection is over: nil when the server ended it (TCP end of stream), else why it failed. Not called after
    /// our own `cancel()`. Once at most.
    var onEnd: ((ZnWsFailure?) -> Void)?

    private let url: URL
    private let key = ZnWsWire.newKey()
    private let protocols: [String]
    private let userAgent: String
    private let queue: DispatchQueue
    private let conn: NWConnection
    private let host: String
    private let port: Int
    private var head: [UInt8] = []
    private var reader: ZnWsReader
    private(set) var open = false
    /// We cancelled, or it ended: nothing more is reported.
    private var over = false

    /// Nil for a URL that is not ws:// or wss:// with a host.
    init?(url: URL, protocols: [String], userAgent: String, maxMessage: Int, queue: DispatchQueue) {
        guard let t = ZnWsWire.target(url), let port = NWEndpoint.Port(rawValue: UInt16(clamping: t.port)), t.port > 0 else { return nil }
        self.url = url
        self.protocols = protocols
        self.userAgent = userAgent
        self.queue = queue
        self.host = t.host
        self.port = t.port
        reader = ZnWsReader(maxMessage: maxMessage)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true  // small frames go out at once (OkHttp sets TCP_NODELAY too)
        let params = NWParameters(tls: t.tls ? NWProtocolTLS.Options() : nil, tcp: tcp)
        conn = NWConnection(to: .hostPort(host: NWEndpoint.Host(t.host), port: port), using: params)
    }

    /// A connection nobody ended (none is expected): don't leave its socket open.
    deinit { if !over { conn.cancel() } }

    func start() {
        conn.stateUpdateHandler = { [weak self] state in
            guard let self, !self.over else { return }
            switch state {
            case .ready:
                self.conn.send(content: ZnWsWire.request(self.url, key: self.key, protocols: self.protocols, userAgent: self.userAgent),
                               completion: .contentProcessed { _ in })
                self.read()
            // Offline, refused, no such host: fail at once, as OkHttp (URLSession's waitsForConnectivity was off too).
            case .waiting(let error), .failed(let error):
                self.end(ZnWsFailure(self.describe(error)))
            default: break
            }
        }
        conn.start(queue: queue)
    }

    func sendText(_ text: String) { write(ZnWsWire.frame(ZnWsWire.opText, Data(text.utf8))) }
    func sendPing() { write(ZnWsWire.frame(ZnWsWire.opPing, Data())) }
    func sendPong(_ payload: Data) { write(ZnWsWire.frame(ZnWsWire.opPong, payload)) }
    func sendClose(_ code: Int?, _ reason: String) { write(ZnWsWire.frame(ZnWsWire.opClose, ZnWsWire.closePayload(code, reason))) }

    /// Sends our answer to the server's close, then ends the connection once it is on its way (TCP's FIN after it).
    func answerCloseAndEnd(_ code: Int?) {
        guard !over else { return }
        over = true
        conn.send(content: ZnWsWire.frame(ZnWsWire.opClose, ZnWsWire.closePayload(code, "")),
                  completion: .contentProcessed { [conn] _ in conn.cancel() })
    }

    /// Ends the connection now (TCP's FIN, or a stop while connecting). Nothing more is reported.
    func cancel() {
        guard !over else { return }
        over = true
        conn.cancel()
    }

    private func write(_ frame: Data) {
        guard !over, open else { return }
        conn.send(content: frame, completion: .contentProcessed { _ in })
    }

    private func read() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, complete, error in
            guard let self, !self.over else { return }
            // What came first, then the end: the bytes before the FIN are never lost.
            if let data, !data.isEmpty { self.take(data) }
            if self.over { return }
            if let error { return self.end(ZnWsFailure(self.describe(error))) }
            if complete {
                return self.end(self.open ? nil : ZnWsFailure("the connection closed before the server's handshake answer"))
            }
            self.read()
        }
    }

    private func take(_ data: Data) {
        if !open {
            head.append(contentsOf: data)
            guard let headLen = ZnWsWire.headEnd(head) else {
                if head.count > ZnWsWire.maxHeadSize { end(ZnWsFailure("The server's handshake answer is too big")) }
                return
            }
            guard let answer = ZnWsWire.parseAnswer(Array(head[..<headLen])) else {
                return self.end(ZnWsFailure("The server's handshake answer is not HTTP"))
            }
            switch ZnWsWire.check(answer, key: key, offered: protocols) {
            case .failure(let f): return self.end(f)
            case .success(let proto):
                open = true
                reader.feed(head[headLen...])
                head = []
                onOpen?(proto)
            }
        } else {
            reader.feed(data)
        }
        do {
            while !over, let event = try reader.next() { onEvent?(event) }
        } catch let f as ZnWsFailure {
            end(f)
        } catch {
            end(ZnWsFailure("\(error)"))
        }
    }

    private func end(_ failure: ZnWsFailure?) {
        guard !over else { return }
        over = true
        conn.cancel()
        onEnd?(failure)
    }

    /// The text JS gets for a Network error, close to OkHttp's.
    private func describe(_ error: NWError) -> String {
        switch error {
        case .posix(let code):
            if code == .ECONNREFUSED { return "Failed to connect to \(host):\(port)" }
            return String(cString: strerror(code.rawValue))
        case .dns: return "Unable to resolve host \"\(host)\": No address associated with hostname"
        case .tls(let status):
            let text = SecCopyErrorMessageString(status, nil) as String? ?? "TLS error \(status)"
            return "TLS: \(text)"
        default: return "\(error)"
        }
    }
}
