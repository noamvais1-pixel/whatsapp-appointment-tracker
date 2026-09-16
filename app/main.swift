import Cocoa
import WebKit

// A small native window for the tracker dashboard. It makes sure the tracker is running,
// then shows http://localhost:PORT in a WebKit view. Closing the window does NOT stop the
// tracker - it keeps reading messages in the background.

let projectDir = "/Users/miriamweiss/Desktop/appointment tracker"
let launchScript = projectDir + "/launch.sh"

func readPort() -> String {
    if let env = try? String(contentsOfFile: projectDir + "/.env", encoding: .utf8) {
        for line in env.split(separator: "\n") where line.hasPrefix("PORT=") {
            let v = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if !v.isEmpty { return v }
        }
    }
    return "3123"
}
let dashboardURL = URL(string: "http://localhost:\(readPort())/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var retries = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()

        let rect = NSRect(x: 0, y: 0, width: 1100, height: 760)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "מעקב פגישות"
        // Liquid-glass feel: the desktop shows through a frosted layer behind the page
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.minSize = NSSize(width: 720, height: 480)
        window.setFrameAutosaveName("MainWindow")
        window.center()

        let cfg = WKWebViewConfiguration()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        // tell the page it runs inside the native window, so it can use a transparent background
        let mark = WKUserScript(source: "document.documentElement.classList.add('native')", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(mark)
        web = WKWebView(frame: rect, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")

        let frost = NSVisualEffectView(frame: rect)
        frost.material = .underWindowBackground
        frost.blendingMode = .behindWindow
        frost.state = .active
        frost.autoresizingMask = [.width, .height]
        frost.addSubview(web)
        window.contentView = frost
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showStatus("מפעיל את התוכנה…")
        ensureTrackerRunning()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Start the tracker in the background (does nothing if it is already running), then load the page.
    func ensureTrackerRunning() {
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [launchScript, "--no-open"]
            try? p.run()
            p.waitUntilExit()
            DispatchQueue.main.async { self.load() }
        }
    }

    func load() { web.load(URLRequest(url: dashboardURL)) }

    func showStatus(_ text: String) {
        let html = """
        <html dir="rtl"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:18px -apple-system,Helvetica;color:#555;background:transparent">\(text)</body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // If the server is not reachable (yet), keep trying for a while.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retries += 1
        if retries < 40 {
            showStatus("מתחבר לתוכנה… (\(retries))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.load() }
        } else {
            showStatus("התוכנה לא עלתה. אפשר לסגור את החלון ולפתוח את האפליקציה שוב.")
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { retries = 0 }

    // JavaScript dialogs (the dashboard uses confirm/prompt/alert).
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "אישור"); a.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "אישור"); a.addButton(withTitle: "ביטול")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt; a.addButton(withTitle: "אישור"); a.addButton(withTitle: "ביטול")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field; a.window.initialFirstResponder = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // Minimal menu so Cmd+Q / Cmd+C / Cmd+V / Cmd+R work.
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "רענון", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(withTitle: "לפתוח בדפדפן", action: #selector(openInBrowser), keyEquivalent: "b")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "לסגור את החלון (התוכנה ממשיכה לרוץ ברקע)", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(withTitle: "יציאה מהחלון", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "עריכה")
        edit.addItem(withTitle: "בטל", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "גזור", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "העתק", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "הדבק", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "בחר הכל", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }
    @objc func reload() { load() }
    @objc func openInBrowser() { NSWorkspace.shared.open(dashboardURL) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
