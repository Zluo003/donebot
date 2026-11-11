import type { NetworkInterfaceInfoIPv4 } from "node:os";
import { describe, expect, it } from "vitest";

import {
  companionEndpointCandidates,
  hostedCompanionUrl,
  MAX_COMPANION_ENDPOINTS,
} from "../src/endpoints.ts";
import { lanAddresses } from "../src/listener.ts";

describe("hostedCompanionUrl", () => {
  it("normalizes one explicit HTTPS origin", () => {
    expect(hostedCompanionUrl("  https://Maus.Example/  ")).toBe("https://maus.example");
    expect(hostedCompanionUrl(undefined)).toBeNull();
    expect(hostedCompanionUrl("  ")).toBeNull();
  });

  it("refuses insecure or ambiguous hosted routes", () => {
    for (const value of [
      "http://maus.example",
      "https://user:secret@maus.example",
      "https://maus.example/companion",
      "https://maus.example?device=one",
      "https://maus.example#pair",
      "not a URL",
    ]) {
      expect(() => hostedCompanionUrl(value)).toThrow(/DONEBOT_COMPANION_HOSTED_URL/);
    }
  });
});

describe("companionEndpointCandidates", () => {
  it("puts hosted HTTPS first, followed by tailnet, LAN, and Bonjour routes", () => {
    expect(
      companionEndpointCandidates(
        18910,
        ["100.121.5.6", "192.168.1.42", "10.0.0.7"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "donebot-abcd1234.local",
      ),
    ).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "http://macbook.tail1234.ts.net:18910", kind: "tailnet", priority: 100 },
      { url: "http://192.168.1.42:18910", kind: "lan", priority: 201 },
      { url: "http://10.0.0.7:18910", kind: "lan", priority: 202 },
      { url: "http://donebot-abcd1234.local:18910", kind: "bonjour", priority: 300 },
    ]);
  });

  it("leads a Windows PC's LAN routes with its Wi-Fi address, not WSL's", () => {
    const ipv4 = (address: string, netmask = "255.255.255.0"): NetworkInterfaceInfoIPv4 => ({
      address, netmask, family: "IPv4", mac: "00:15:5d:00:00:01", internal: false, cidr: `${address}/24`,
    });
    const windows = lanAddresses({
      "vEthernet (WSL (Hyper-V firewall))": [ipv4("172.19.96.1", "255.255.240.0")],
      "Wi-Fi": [ipv4("192.168.1.34")],
    });
    const lan = companionEndpointCandidates(18910, windows, null, null, "miguel.local")
      .filter((endpoint) => endpoint.kind === "lan");
    expect(lan.map((endpoint) => endpoint.url)).toEqual(["http://192.168.1.34:18910", "http://172.19.96.1:18910"]);
  });

  it("keeps direct routes when no hosted route exists", () => {
    expect(
      companionEndpointCandidates(18910, ["192.168.1.42"], null, null, "donebot-abcd1234.local"),
    ).toEqual([
      { url: "http://192.168.1.42:18910", kind: "lan", priority: 200 },
      { url: "http://donebot-abcd1234.local:18910", kind: "bonjour", priority: 300 },
    ]);
  });

  it("caps pathological interface lists without losing the Bonjour fallback", () => {
    const addresses = Array.from({ length: 20 }, (_, index) => `192.168.1.${index + 1}`);
    const endpoints = companionEndpointCandidates(
      18910,
      addresses,
      null,
      "https://device-123.companion.example",
      "donebot-abcd1234.local",
    );
    expect(endpoints).toHaveLength(MAX_COMPANION_ENDPOINTS);
    expect(endpoints[0]).toMatchObject({ kind: "hosted", priority: 0 });
    expect(endpoints.at(-1)).toEqual({
      url: "http://donebot-abcd1234.local:18910",
      kind: "bonjour",
      priority: 300,
    });
  });
});
