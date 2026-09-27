import UIKit
import WebKit
import Capacitor

// A single bridge keeps every tab on the same in-memory and persisted diary.
final class BayDiaryViewController: UIViewController, UITabBarDelegate {
    private let content = DiaryBridgeController()
    private let tabs = UITabBar()
    private let routes = ["dashboard", "analysis", "list", "players", "settings"]
    private var currentRoute = "dashboard"
    private var contentBottom: NSLayoutConstraint!
    private var fullBottom: NSLayoutConstraint!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        content.onRoute = { [weak self] route in self?.showRoute(route) }
        addChild(content)
        view.addSubview(content.view)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        content.didMove(toParent: self)
        tabs.delegate = self
        tabs.translatesAutoresizingMaskIntoConstraints = false
        let labels = ["ホーム", "成績", "記録", "選手", "設定"]
        let symbols = ["house", "chart.bar", "book.closed", "person.2", "gearshape"]
        tabs.items = routes.indices.map { i in
            let item = UITabBarItem(title: labels[i], image: UIImage(systemName: symbols[i]), tag: i)
            item.accessibilityIdentifier = "tab-" + routes[i]
            return item
        }
        tabs.selectedItem = tabs.items?.first
        tabs.tintColor = .systemBlue
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground()
        tabs.standardAppearance = appearance
        tabs.scrollEdgeAppearance = appearance
        view.addSubview(tabs)
        contentBottom = content.view.bottomAnchor.constraint(equalTo: tabs.topAnchor)
        fullBottom = content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            content.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentBottom,
            tabs.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabs.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabs.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        // Let UITabBar size itself (intrinsicContentSize) instead of forcing a fixed
        // 49pt height: a hardcoded height clipped the icon+label pair on current iOS,
        // which renders the standard tab bar taller than the old fixed value.
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard routes.indices.contains(item.tag) else { return }
        let route = routes[item.tag]
        // Allow-list route names instead of evaluating arbitrary messages as code.
        content.webView?.evaluateJavaScript("window.bayNavigate && window.bayNavigate('\(route)')") { [weak self] value, error in
            guard let self else { return }
            if error != nil || (value as? Bool) != true {
                self.tabs.selectedItem = self.tabs.items?[self.routes.firstIndex(of: self.currentRoute) ?? 0]
            } else {
                UISelectionFeedbackGenerator().selectionChanged()
            }
        }
    }

    private func showRoute(_ route: String) {
        guard routes.contains(route) || route == "form" || route == "memo" else { return }
        let editing = route == "form" || route == "memo"
        tabs.isHidden = editing
        NSLayoutConstraint.deactivate([contentBottom, fullBottom])
        (editing ? fullBottom : contentBottom)?.isActive = true
        if let index = routes.firstIndex(of: route) {
            currentRoute = route
            tabs.selectedItem = tabs.items?[index]
        }
    }
}

private final class DiaryBridgeController: CAPBridgeViewController, WKScriptMessageHandler {
    var onRoute: ((String) -> Void)?
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.isOpaque = false
        webView?.backgroundColor = .systemGroupedBackground
        webView?.scrollView.backgroundColor = .systemGroupedBackground
        guard let controller = webView?.configuration.userContentController else { return }
        controller.add(WeakDiaryHandler(self), name: "baydiaryRoute")
        controller.addUserScript(WKUserScript(source: "window.BayDiaryShell = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let route = message.body as? String else { return }
        onRoute?(route)
    }
}
private final class WeakDiaryHandler: NSObject, WKScriptMessageHandler {
    private weak var target: DiaryBridgeController?
    init(_ target: DiaryBridgeController) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
