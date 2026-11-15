const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { childDigest, compareVersions, versionFromImage } = require("../../scripts/image-version");

const image = (version) => ({ architecture: "amd64", os: "linux", config: { Labels: { "org.opencontainers.image.version": version } } });
const digest = (c) => `sha256:${c.repeat(64)}`;

describe("读取已发布镜像的版本（每周重建是否改动 latest）", () => {
  it("单架构镜像与多架构清单（平台 → 镜像配置）都能读出版本；null、空输入或没有标签时为空", () => {
    assert.equal(versionFromImage(JSON.stringify(image("0.3.3"))), "0.3.3");
    assert.equal(versionFromImage(JSON.stringify({ "linux/amd64": image("0.4.0"), "linux/arm64": image("0.4.0") })), "0.4.0");
    assert.equal(versionFromImage(JSON.stringify({ "linux/amd64": { config: {} }, "linux/arm64": image("0.4.0") })), "0.4.0");
    for (const text of ["null", "", "not json", "{}", JSON.stringify({ config: { Labels: null } }), JSON.stringify({ "linux/amd64": null })]) {
      assert.equal(versionFromImage(text), "", text);
    }
  });

  it("从多架构清单取第一个平台的摘要，跳过构建证明（unknown/unknown）", () => {
    const raw = {
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { digest: digest("a"), platform: { os: "unknown", architecture: "unknown" } },
        { digest: digest("b"), platform: { os: "linux", architecture: "amd64" } },
        { digest: digest("c"), platform: { os: "linux", architecture: "arm64" } },
      ],
    };
    assert.equal(childDigest(JSON.stringify(raw)), digest("b"));
    assert.equal(childDigest(JSON.stringify({ manifests: [{ digest: "sha256:../x", platform: { os: "linux" } }] })), "");
    assert.equal(childDigest(JSON.stringify(image("0.3.3"))), "");
    assert.equal(childDigest("null"), "");
  });

  it("比较版本：只有 latest 比本次新时才保持不变；读不到时为 unknown", () => {
    assert.equal(compareVersions("0.4.1", "0.4.0"), "newer");
    assert.equal(compareVersions("0.10.0", "0.9.9"), "newer");
    assert.equal(compareVersions("0.4.0", "0.4.0"), "same");
    assert.equal(compareVersions("0.3.3", "0.4.0"), "older");
    assert.equal(compareVersions("", "0.4.0"), "unknown");
    assert.equal(compareVersions("dev", "0.4.0"), "unknown");
  });
});
