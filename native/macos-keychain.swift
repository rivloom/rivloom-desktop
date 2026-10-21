import Foundation
import Security

// No command-line arguments or environment variables select a keychain or carry a secret.
let service = "com.rivloom.macospreview.node-identity.v1"
let inputLimit = 8192
let keyPrefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
#if RIVLOOM_KEYCHAIN_TESTING
var controlPhase: String?
var controlStatus: OSStatus?
var controlLockSettings: [String: Any]?
#endif

func reply(_ value: [String: Any], _ status: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
        ?? Data("{\"version\":1,\"ok\":false,\"error\":\"internal-error\"}".utf8)
    FileHandle.standardOutput.write(data)
    exit(status)
}

func fail(_ code: String) -> Never {
#if RIVLOOM_KEYCHAIN_TESTING
    if let controlPhase {
        var response: [String: Any] = ["version": 1, "ok": false, "error": code, "phase": controlPhase]
        if let controlStatus { response["nativeStatus"] = controlStatus }
        if let controlLockSettings { response["lockSettings"] = controlLockSettings }
        reply(response, 1)
    }
#endif
    reply(["version": 1, "ok": false, "error": code], 1)
}

func requireSuccess(_ status: OSStatus) {
#if RIVLOOM_KEYCHAIN_TESTING
    if status != errSecSuccess { controlStatus = status }
#endif
    switch status {
    case errSecSuccess: return
    case errSecItemNotFound: fail("not-found")
    case errSecDuplicateItem: fail("duplicate")
    case errSecAuthFailed, errSecUserCanceled, errSecInteractionNotAllowed: fail("access-denied")
    default: fail("unavailable")
    }
}

func readRequest() -> [String: Any] {
    guard CommandLine.arguments.count == 1 else { fail("invalid-request") }
    var bytes = Data()
    do {
        while let part = try FileHandle.standardInput.read(upToCount: min(4096, inputLimit + 1 - bytes.count)), !part.isEmpty {
            bytes.append(part)
            guard bytes.count <= inputLimit else { fail("invalid-request") }
        }
        guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let version = value["version"] as? Int, version == 1 else { fail("invalid-request") }
        return value
    } catch { fail("invalid-request") }
}

#if RIVLOOM_KEYCHAIN_TESTING
// This block is compiled only into a CI control executable, never the shipped helper.
func keychainPath(_ keychain: SecKeychain) -> String {
    var size: UInt32 = 4096
    var bytes = [CChar](repeating: 0, count: Int(size))
    requireSuccess(SecKeychainGetPath(keychain, &size, &bytes))
    return String(cString: bytes)
}

func openKeychain(_ path: String) -> SecKeychain {
    guard path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\0") else { fail("invalid-request") }
    var keychain: SecKeychain?
    requireSuccess(SecKeychainOpen(path, &keychain))
    guard let keychain else { fail("unavailable") }
    return keychain
}

func testPath(_ request: [String: Any]) -> String {
    guard let path = request["keychainPath"] as? String,
          path.hasPrefix("/"), path.utf8.count <= 4096,
          URL(fileURLWithPath: path).lastPathComponent == "rivloom-macos-ci.keychain-db",
          URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent.hasPrefix("rivloom-macos-keychain-")
    else { fail("invalid-request") }
    return path
}

func controlTestKeychain(_ request: [String: Any], _ operation: String) -> Never {
    controlPhase = "disable-interaction"
    requireSuccess(SecKeychainSetUserInteractionAllowed(false))
    let path = testPath(request)
    if operation == "test-snapshot" {
        guard Set(request.keys) == Set(["version", "operation", "keychainPath"]) else { fail("invalid-request") }
        controlPhase = "snapshot-default"
        var previousDefault: SecKeychain?
        requireSuccess(SecKeychainCopyDefault(&previousDefault))
        controlPhase = "snapshot-search-list"
        var previousList: CFArray?
        requireSuccess(SecKeychainCopySearchList(&previousList))
        guard let previousDefault, let previousList else { fail("unavailable") }
        reply(["version": 1, "ok": true, "previousDefault": keychainPath(previousDefault),
            "previousSearchList": (previousList as NSArray).map { keychainPath($0 as! SecKeychain) }])
    }
    if operation == "test-create" {
        guard Set(request.keys) == Set(["version", "operation", "keychainPath", "password", "previousDefault", "previousSearchList"]),
              let password = request["password"] as? String, password.utf8.count == 64,
              password.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let recordedDefault = request["previousDefault"] as? String,
              let recordedSearchList = request["previousSearchList"] as? [String],
              !FileManager.default.fileExists(atPath: path) else { fail("invalid-request") }
        controlPhase = "verify-default"
        var previousDefault: SecKeychain?
        requireSuccess(SecKeychainCopyDefault(&previousDefault))
        controlPhase = "verify-search-list"
        var previousList: CFArray?
        requireSuccess(SecKeychainCopySearchList(&previousList))
        guard let previousDefault, let previousList else { fail("unavailable") }
        let oldPaths = (previousList as NSArray).map { keychainPath($0 as! SecKeychain) }
        guard keychainPath(previousDefault) == recordedDefault, oldPaths == recordedSearchList else { fail("invalid-request") }
        controlPhase = "create"
        var created: SecKeychain?
        let passwordData = Data(password.utf8)
        let status = passwordData.withUnsafeBytes { pointer in
            SecKeychainCreate(path, UInt32(passwordData.count), pointer.baseAddress, false, nil, &created)
        }
        // Creation may add the new keychain to the search list; preserve the previous list now.
        let restored = SecKeychainSetSearchList(previousList)
        requireSuccess(status)
        controlPhase = "create-restore-search-list"
        requireSuccess(restored)
        guard let created else { fail("unavailable") }
        func abortCreated(_ status: OSStatus, _ phase: String) -> Never {
            controlPhase = "create-cleanup-delete"
            requireSuccess(SecKeychainDelete(created))
            controlPhase = phase
            requireSuccess(status)
            fail("unavailable")
        }
        // Never depend on interactive unlock on an unattended runner. The password
        // exists only in this request's memory and is not returned or persisted.
        controlPhase = "unlock-created"
        let unlocked = passwordData.withUnsafeBytes { pointer in
            SecKeychainUnlock(created, UInt32(passwordData.count), pointer.baseAddress, true)
        }
        if unlocked != errSecSuccess { abortCreated(unlocked, "unlock-created") }
        // SecurityTool's no-timeout sentinel is INT_MAX, not UINT32_MAX.
        // New keychains may already have this policy, so first read it without
        // requesting an unnecessary settings authorization on an unattended runner.
        let noTimeout = UInt32(Int32.max)
        func readSettings() -> SecKeychainSettings {
            controlPhase = "read-created-settings"
            var settings = SecKeychainSettings(version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: false, useLockInterval: false, lockInterval: 0)
            requireSuccess(SecKeychainCopySettings(created, &settings))
            controlLockSettings = ["lockOnSleep": settings.lockOnSleep.boolValue, "lockInterval": settings.lockInterval,
                "idleTimeoutDisabled": settings.lockInterval == noTimeout]
            return settings
        }
        var settings = readSettings()
        let settingsChanged = settings.lockOnSleep.boolValue || settings.lockInterval != noTimeout
        if settingsChanged {
            controlPhase = "configure-created"
            var desired = SecKeychainSettings(version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: false, useLockInterval: false, lockInterval: noTimeout)
            let configured = SecKeychainSetSettings(created, &desired)
            if configured != errSecSuccess { abortCreated(configured, "configure-created") }
            settings = readSettings()
        }
        controlPhase = "verify-created-settings"
        guard !settings.lockOnSleep.boolValue, settings.lockInterval == noTimeout else { fail("unavailable") }
        controlPhase = "created-path"
        reply(["version": 1, "ok": true, "keychainPath": keychainPath(created), "lockSettings": controlLockSettings!, "settingsChanged": settingsChanged])
    }
    if operation == "test-activate" {
        guard Set(request.keys) == Set(["version", "operation", "keychainPath"]) else { fail("invalid-request") }
        controlPhase = "activate-open"
        let keychain = openKeychain(path)
        controlPhase = "activate-default"
        requireSuccess(SecKeychainSetDefault(keychain))
        controlPhase = "activate-search-list"
        requireSuccess(SecKeychainSetSearchList([keychain] as CFArray))
        reply(["version": 1, "ok": true])
    }
    if operation == "test-restore" {
        guard Set(request.keys) == Set(["version", "operation", "keychainPath", "previousDefault", "previousSearchList"]),
              let previousDefault = request["previousDefault"] as? String,
              let previousPaths = request["previousSearchList"] as? [String], previousPaths.count <= 32 else { fail("invalid-request") }
        controlPhase = "restore-current-default"
        var current: SecKeychain?
        requireSuccess(SecKeychainCopyDefault(&current))
        guard let current, [path, previousDefault].contains(keychainPath(current)) else { fail("invalid-request") }
        let oldDefault = openKeychain(previousDefault)
        let oldList = previousPaths.map { openKeychain($0) }
        controlPhase = "restore-default"
        requireSuccess(SecKeychainSetDefault(oldDefault))
        controlPhase = "restore-search-list"
        requireSuccess(SecKeychainSetSearchList(oldList as CFArray))
        // A durable prepared state is written before creation, so an interrupted
        // setup can legitimately require restoration without a keychain file yet.
        let present = FileManager.default.fileExists(atPath: path)
        if present {
            controlPhase = "restore-delete"
            requireSuccess(SecKeychainDelete(openKeychain(path)))
        }
        reply(["version": 1, "ok": true, "deleted": present])
    }
    fail("invalid-request")
}
#endif

let request = readRequest()
guard let operation = request["operation"] as? String else { fail("invalid-request") }
#if RIVLOOM_KEYCHAIN_TESTING
if operation.hasPrefix("test-") { controlTestKeychain(request, operation) }
#endif
guard ["create", "read", "delete"].contains(operation),
      let reference = request["reference"] as? String,
      reference.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
      Set(request.keys) == Set(operation == "create" ? ["version", "operation", "reference", "secret"] : ["version", "operation", "reference"])
else { fail("invalid-request") }

var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: reference]
switch operation {
case "create":
    guard let encoded = request["secret"] as? String, let secret = Data(base64Encoded: encoded),
          encoded == secret.base64EncodedString(), secret.count == 48, secret.starts(with: keyPrefix) else { fail("invalid-data") }
    query[kSecValueData as String] = secret
    query[kSecAttrLabel as String] = "Rivloom Mac Preview node identity"
    requireSuccess(SecItemAdd(query as CFDictionary, nil))
    reply(["version": 1, "ok": true])
case "read":
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    requireSuccess(SecItemCopyMatching(query as CFDictionary, &result))
    guard let secret = result as? Data, secret.count == 48, secret.starts(with: keyPrefix) else { fail("invalid-data") }
    reply(["version": 1, "ok": true, "secret": secret.base64EncodedString()])
case "delete":
    requireSuccess(SecItemDelete(query as CFDictionary))
    reply(["version": 1, "ok": true])
default: fail("invalid-request")
}
