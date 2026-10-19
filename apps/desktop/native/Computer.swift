import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

// No prompt-on-read: macOS privacy consent is always granted by the human in System Settings.
@main struct Computer {
  static func fail(_ message: String) throws -> Never { throw NSError(domain: "DogO", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  static func emit(_ value: [String: Any]) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value)) }
  static func main() async {
    do {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard data.count <= 64000, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any], let action = input["action"] as? String else { try fail("Invalid operation") }
      if action == "status" { try emit(["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]); return }
      if action == "screenshot" {
        guard CGPreflightScreenCaptureAccess() else { try fail("请在系统设置中为 DogO 开启屏幕录制权限") }
        let available = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = available.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? available.displays.first else { try fail("没有可用屏幕") }
        let bounds = CGDisplayBounds(display.displayID)
        let config = SCStreamConfiguration(); config.width = Int(bounds.width); config.height = Int(bounds.height); config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil) else { try fail("Cannot encode screenshot") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { try fail("Screenshot incomplete") }
        try emit(["png": (bytes as Data).base64EncodedString(), "width": image.width, "height": image.height, "originX": bounds.minX, "originY": bounds.minY]); return
      }
      guard AXIsProcessTrusted() else { try fail("请在系统设置中为 DogO 开启辅助功能权限") }
      let source = CGEventSource(stateID: .hidSystemState)
      switch action {
      case "click":
        guard let x = input["x"] as? Double, let y = input["y"] as? Double, x.isFinite, y.isFinite else { try fail("Invalid point") }
        let point = CGPoint(x: x, y: y)
        let displays = NSScreen.screens.map { screen -> CGRect in let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID(); return CGDisplayBounds(id) }
        guard displays.contains(where: { $0.contains(point) }) else { try fail("坐标不在当前屏幕内") }
        let right = (input["button"] as? String) == "right", button: CGMouseButton = right ? .right : .left
        let count = input["count"] as? Int ?? 1
        guard (1...2).contains(count) else { try fail("Invalid click count") }
        for n in 1...count {
          for type: CGEventType in [right ? .rightMouseDown : .leftMouseDown, right ? .rightMouseUp : .leftMouseUp] {
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(n)); event?.post(tap: .cghidEventTap)
            try await Task.sleep(nanoseconds: 40_000_000)
          }
        }
      case "type":
        guard let text = input["text"] as? String, text.utf16.count <= 8000 else { try fail("Text too large") }
        // Send complete Characters, so Chinese and surrogate pairs are never split across events.
        for character in text {
          let units = Array(String(character).utf16)
          for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down); event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units); event?.post(tap: .cghidEventTap) }
          try await Task.sleep(nanoseconds: 20_000_000)
        }
      case "key":
        let codes: [String: CGKeyCode] = ["return": 36, "tab": 48, "escape": 53, "backspace": 51, "left": 123, "right": 124, "up": 126, "down": 125, "a": 0, "c": 8, "v": 9]
        guard let name = input["key"] as? String, let code = codes[name] else { try fail("Unsupported key") }
        var flags: CGEventFlags = []
        for modifier in input["modifiers"] as? [String] ?? [] {
          switch modifier { case "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "option": flags.insert(.maskAlternate); case "control": flags.insert(.maskControl); default: try fail("Unsupported modifier") }
        }
        for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down); event?.flags = flags; event?.post(tap: .cghidEventTap) }
      case "scroll":
        guard let amount = input["amount"] as? Int, abs(amount) <= 1000 else { try fail("Invalid scroll") }
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(amount), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
      case "activate":
        guard let bundle = input["bundleId"] as? String, bundle.range(of: "^[a-zA-Z0-9][a-zA-Z0-9.-]+$", options: .regularExpression) != nil,
          let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { try fail("应用未安装或标识无效") }
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
      default: try fail("Unsupported operation")
      }
      try await Task.sleep(nanoseconds: 80_000_000)
      try emit(["completed": true, "action": action])
    } catch { FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1) }
  }
}
