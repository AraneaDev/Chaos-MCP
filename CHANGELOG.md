# Changelog

All notable changes to Chaos-MCP are documented in this file.

## [4.0.0](https://github.com/AraneaDev/Chaos-MCP/compare/v3.0.1...v4.0.0) (2026-08-23)


### ⚠ BREAKING CHANGES

* Node 22 is no longer supported. Chaos-MCP now requires Node 24.11.0 or later. Node 22 remains in upstream maintenance until 2027-04-30, so this drops a line that is still receiving security fixes.

### Features

* **containers:** ship StrykerJS 10 in the TypeScript runner image ([7f72451](https://github.com/AraneaDev/Chaos-MCP/commit/7f72451c5f01de73bae6e91efc360c4651fc1023))
* **detectors:** use the native vitest runner for vitest 2 and up ([68306aa](https://github.com/AraneaDev/Chaos-MCP/commit/68306aa0a32230846a7e6d60a5f65a48635f33a3))
* require Node 24.11.0 and drop Node 22 ([aade0e8](https://github.com/AraneaDev/Chaos-MCP/commit/aade0e84d6cac9f3597b2afa2b22103b90a7036a))


### Bug Fixes

* address CodeRabbit review on the mutation-testing PR ([1e26293](https://github.com/AraneaDev/Chaos-MCP/commit/1e26293a5add1d47bd92fb4fa79c71ddb815592b))
* **engines:** fall back to the command runner when the native vitest dry run fails ([f5ce47d](https://github.com/AraneaDev/Chaos-MCP/commit/f5ce47d8fd35a9e9f604ce38758fde7030c8413f))

## [3.0.1](https://github.com/AraneaDev/Chaos-MCP/compare/v3.0.0...v3.0.1) (2026-08-14)


### Bug Fixes

* **estimate:** judge a suite timeout by the cap the suite actually got ([9775c93](https://github.com/AraneaDev/Chaos-MCP/commit/9775c935cec6db042ad7ec130dec5c0234bd448c))
* **review:** report suppression edits in verify mode, clamp measured startup ([9cb3f92](https://github.com/AraneaDev/Chaos-MCP/commit/9cb3f924bb1ad985440233b91d18ad50ed922475))
* **rust:** correct mutant classification, timing and path reporting ([a7faaee](https://github.com/AraneaDev/Chaos-MCP/commit/a7faaee759450ca42911994a57feb1f2d9f4ccc1))
* **rust:** correct mutant classification, timing and path reporting ([505acc9](https://github.com/AraneaDev/Chaos-MCP/commit/505acc9681233db2c9d0c46e543f372c75016073))

## [3.0.0](https://github.com/AraneaDev/Chaos-MCP/compare/v2.0.0...v3.0.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* **suppression:** identify entries by change, relocate instead of drifting

### Features

* **php:** report original and mutated instead of the raw diff ([9428325](https://github.com/AraneaDev/Chaos-MCP/commit/942832582862b4031c148f8e1f84d6f6e936354c))
* **suppression:** add mutant identity module ([6409d61](https://github.com/AraneaDev/Chaos-MCP/commit/6409d613f2b745f293ec72c5227cba191d9fcf3c))
* **suppression:** identify entries by change, relocate instead of drifting ([aeb619d](https://github.com/AraneaDev/Chaos-MCP/commit/aeb619d0a07443a3ad993f4ba0a4415e9a0ad073))
* **suppression:** resolve the change at write time, refuse ambiguous entries ([d0f6a59](https://github.com/AraneaDev/Chaos-MCP/commit/d0f6a5970cb135fd4a1c48c726e41f5ec9ddf49d))
* **suppression:** return the candidate changes when an add is ambiguous ([b849fc3](https://github.com/AraneaDev/Chaos-MCP/commit/b849fc348ffd72698559ad4c89d9c65d0d1fcd4f))


### Bug Fixes

* **suppression:** address a relocating entry by its stored line ([aabfbc3](https://github.com/AraneaDev/Chaos-MCP/commit/aabfbc34bc39f6c891a1a5a60c40e60d3ed439d0))
* **suppression:** key stored entries by line, not by content digest ([a4bd4ed](https://github.com/AraneaDev/Chaos-MCP/commit/a4bd4edd8d029c06d93225361fc5b05e3508795e))
* **suppression:** refuse a changeless entry when the run stopped early ([9cfba9f](https://github.com/AraneaDev/Chaos-MCP/commit/9cfba9fe4c3aec150e8f4f99fc1c7a7e733c588d))
* **suppression:** stop two same-change mutants collapsing into one entry ([01d49c2](https://github.com/AraneaDev/Chaos-MCP/commit/01d49c2fc9476af276a1728e1989f82c4097df18))

## [2.0.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.8.1...v2.0.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **cli:** the minimum supported Node.js runtime is now 22.11.0 (was 22.0.0), the first 22.x LTS release. Runtimes `>=22.0.0 <22.11.0` are no longer supported: `checkNodeVersion` prints an upgrade message and exits 1 below the floor, and `scripts/install.sh` raised its own `MIN_NODE_VERSION` constant from 22.0.0 to 22.11.0 so the installer cannot provision a runtime the server then refuses to start on. ([aaf7530](https://github.com/AraneaDev/Chaos-MCP/commit/aaf7530eab3df3b97df657196c5026c8c77e8353))

<!--
  The two entries release-please originally generated here read
  "**cli:** ` if the floor bump should be treated as breaking." under a stray
  "### `feat" heading. That text was not a description: commit aaf7530's BODY
  explained why the change was committed as `fix` rather than as a breaking
  change, and in doing so quoted the literal token `feat(cli)!:`. The
  conventional-commit parser matched that token inside the sentence and read the
  remainder of the line - starting at the closing backtick - as a breaking
  change description. Corrected by hand; the 2.0.0 version itself is right,
  since raising the runtime floor is a breaking change on its own merits.
-->


### Features

* **suppression:** report suppressions the write refused to store ([638757a](https://github.com/AraneaDev/Chaos-MCP/commit/638757a1eaf11a11d51f9e5aa1bd426ac7647262))


### Bug Fixes

* **cli:** raise the Node floor to 22.11.0 and revive the minor check ([aaf7530](https://github.com/AraneaDev/Chaos-MCP/commit/aaf7530eab3df3b97df657196c5026c8c77e8353))
* declare rejectedSuppressions in the output schema, align the installer ([35d25bd](https://github.com/AraneaDev/Chaos-MCP/commit/35d25bd3ca49b5649802145ab9cbbbfdab7fea9d))
* **suppression:** finish re-deriving the corpus (119 -&gt; 60 entries) ([232f673](https://github.com/AraneaDev/Chaos-MCP/commit/232f6733254e2160e2bf86488d9c37f6d3b49e23))
* **suppression:** re-derive five more corpora, cover an estimate guard ([52d25d0](https://github.com/AraneaDev/Chaos-MCP/commit/52d25d0bac4d218e6b1c39d8038c5801056c0c7d))
* **suppression:** re-derive suppression.ts's own corpus, cover the new guard ([17906f0](https://github.com/AraneaDev/Chaos-MCP/commit/17906f00ddb4d6d38d68cd3f1b9531d37309624b))
* **suppression:** re-derive test-file.ts's corpus ([a27f6b1](https://github.com/AraneaDev/Chaos-MCP/commit/a27f6b13e816ae622b638473d02bb4843ce79f29))
* **suppression:** re-derive tool-args-validation.ts's corpus ([d5e5280](https://github.com/AraneaDev/Chaos-MCP/commit/d5e528062e713e8cd4918982d5badb367cfe6357))
* **suppression:** refuse a suppression no mutant can occupy ([e3e9f43](https://github.com/AraneaDev/Chaos-MCP/commit/e3e9f43c6369ca550ba6f772e5076575279635f4))
* **tests:** make suppression.ts auditable again, cover its boundaries ([3eccb2e](https://github.com/AraneaDev/Chaos-MCP/commit/3eccb2e5d31a127d4682bd95940b802f328b933b))

## [1.8.1](https://github.com/AraneaDev/Chaos-MCP/compare/v1.8.0...v1.8.1) (2026-08-09)


### Bug Fixes

* **typescript:** fund a batch by its own start-up, not the average share ([403f46e](https://github.com/AraneaDev/Chaos-MCP/commit/403f46e5e0f2ba4e328baad8f5c6283a2b8668f0))
* **typescript:** fund a batch by its own start-up, not the average share ([0c0d86a](https://github.com/AraneaDev/Chaos-MCP/commit/0c0d86ae503c91b8439a21136bae60f0ab291a1d))

## [1.8.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.7.0...v1.8.0) (2026-08-09)


### Features

* **sandbox:** add a dependencies mode for copy or whole-directory sharing ([e6a9c29](https://github.com/AraneaDev/Chaos-MCP/commit/e6a9c298388faf91077cb7a90aff9bd4104acd4f))
* **suppressions:** report entries that matched no mutant ([d050882](https://github.com/AraneaDev/Chaos-MCP/commit/d0508820f8e099a79dd61917456fceb8f6b0872e))
* **suppressions:** surface orphanedSuppressions in every output shape ([c6bc13f](https://github.com/AraneaDev/Chaos-MCP/commit/c6bc13f5091cbc3948f26b8116973e599d3c1739))


### Bug Fixes

* **config:** warn that mutatorAllowlist is accepted and then ignored ([1b812fb](https://github.com/AraneaDev/Chaos-MCP/commit/1b812fb3d13f668001985835c653816223cfd43c))
* **container:** bind-mount the dependency tree under link-entries and copy modes ([90be1ba](https://github.com/AraneaDev/Chaos-MCP/commit/90be1ba0de41b38b4c8aef3597461fa80e5d5fda))
* **container:** pass workspaceRoot and dependencyMode instead of inferring the host root ([88f7250](https://github.com/AraneaDev/Chaos-MCP/commit/88f72506d39666976bde9da8d8e8d6c6a3820b80))
* **detectors:** anchor the pytest table probes to a line of their own ([832f93d](https://github.com/AraneaDev/Chaos-MCP/commit/832f93d1977cffbd5a946b8f91ad338b600b1f72))
* **engines:** declare whole-file scopeKind on the three engines that never scope ([03d54e7](https://github.com/AraneaDev/Chaos-MCP/commit/03d54e7af2013d97dc42650570d694a3062f4629))
* **estimate:** grade a baseline that outran its cap instead of dropping it ([61315f2](https://github.com/AraneaDev/Chaos-MCP/commit/61315f2c27a82891ebe7c738a4bafc71afc1ba3b))
* **estimate:** only declare a budget missed when the baseline cap covers it ([e2d0986](https://github.com/AraneaDev/Chaos-MCP/commit/e2d098677e303ffa0a016c969692547c5e6f2d67))
* **git-diff:** stop reporting our own failures as facts about the repo ([570a607](https://github.com/AraneaDev/Chaos-MCP/commit/570a607c8944a30f769b097ea1d41f6c0c3a09b1))
* **git-diff:** treat only exit 1 from ls-files as untracked ([48db1d5](https://github.com/AraneaDev/Chaos-MCP/commit/48db1d5f78b49a34bd710e4fbfc8740cc2602424))
* **python:** quote test-selection paths so shlex cannot split them ([c959541](https://github.com/AraneaDev/Chaos-MCP/commit/c9595419e65950fc5d0d1ef5735763398aaa58fb))
* **python:** quote the interpreter path so shlex cannot eat its separators ([4cbddcc](https://github.com/AraneaDev/Chaos-MCP/commit/4cbddcc35b3a031070dd6f412ec9564de436a3ef))
* remediate the v1.7.0 comprehensive logic audit ([f16d6b1](https://github.com/AraneaDev/Chaos-MCP/commit/f16d6b1e12d95de43ca475e19826b8ab9a1e845a))
* **run-cache:** don't drop an eviction index entry when its rmSync fails ([dd92b4d](https://github.com/AraneaDev/Chaos-MCP/commit/dd92b4d52da77c54c89960095f91a0173f972ff5))
* **sandbox:** let ignorePatterns exclude a dependency directory ([ef72e78](https://github.com/AraneaDev/Chaos-MCP/commit/ef72e78259e2d65635e24a7a9624fdacca8a9ef9))
* **sandbox:** link dependency entries so sandbox writes stay in the sandbox ([d67f8d2](https://github.com/AraneaDev/Chaos-MCP/commit/d67f8d202bf17b4f69bcb1f3ffc917c69b08d3ea))
* **sandbox:** report the size threshold instead of a truncated total ([76a2e9f](https://github.com/AraneaDev/Chaos-MCP/commit/76a2e9f2451dac9fe52db3be7480a54e42cfd0e6))
* **sandbox:** warn about an excluded dependency directory under copy mode too ([c0626da](https://github.com/AraneaDev/Chaos-MCP/commit/c0626da21a91695b178a036f4ce8c46e0a04dfe0))
* **sandbox:** warn on an excluded dependency directory, and type entry links by their target ([bcfc773](https://github.com/AraneaDev/Chaos-MCP/commit/bcfc7733a110ce342ef41b6584cdf53793351b91))
* **sandbox:** warn on dependency-link failures, fix symlink type, retest gaps ([c4e5a65](https://github.com/AraneaDev/Chaos-MCP/commit/c4e5a65c7b71c7409d88c5f65808c747042f74b1))
* **suppressions:** fall back to whole-file when an engine never sets scopeKind ([2e31f73](https://github.com/AraneaDev/Chaos-MCP/commit/2e31f7374477383619ea7598569ca3609dc01640))
* **suppressions:** gate the audit-side orphan count on the pre-suppression result ([97cd5e7](https://github.com/AraneaDev/Chaos-MCP/commit/97cd5e7d169d46198a804847116f509fee6014c5))
* **suppressions:** gate the orphan count on a completed run, and stop asserting its cause ([e96ff42](https://github.com/AraneaDev/Chaos-MCP/commit/e96ff42c60912497379621a41b85ecd5654abaa3))
* **typescript:** bound batch count by requested ranges too, not just spanned lines ([167b4ce](https://github.com/AraneaDev/Chaos-MCP/commit/167b4ceb2e39e31523618801828a941693888670))
* **typescript:** bound batches by the emitted count, not a range-count proxy ([ec4a1c0](https://github.com/AraneaDev/Chaos-MCP/commit/ec4a1c0b4e0caeb12f41ce47f93fedafeaf85eb1))
* **typescript:** size mutation batches against the time budget ([3e99b50](https://github.com/AraneaDev/Chaos-MCP/commit/3e99b5094bd1ef1c8f833151b920a2a085814ded))


### Performance Improvements

* **run-cache:** evict from an in-memory index instead of parsing every entry ([9b46d49](https://github.com/AraneaDev/Chaos-MCP/commit/9b46d4962f8cd11762165f5a4d1cfef99a32d6bf))
* **sandbox:** memoise the pre-copy workspace size probe ([b4dbc5a](https://github.com/AraneaDev/Chaos-MCP/commit/b4dbc5ad4beaf415649ec692f1f5d4401040eef6))

## [1.7.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.6.0...v1.7.0) (2026-08-02)


### Features

* **arch:** declare boundary policies and make utils a true leaf ([db9e6d1](https://github.com/AraneaDev/Chaos-MCP/commit/db9e6d1881e64d0b5768e43c58f45b0d7003f72d))
* **container:** allow the execution mode to be set per language ([3300e71](https://github.com/AraneaDev/Chaos-MCP/commit/3300e71f997ca7afef5558f7cbd5a8e9e41c33ac))
* **suppression:** fingerprint suppressed mutants and fail safe on drift ([7b3b4f1](https://github.com/AraneaDev/Chaos-MCP/commit/7b3b4f1a0c56a917b347cf126033bfc61ea537bb))


### Bug Fixes

* **arch:** break the cycle the suppression extraction introduced ([9b9c7a9](https://github.com/AraneaDev/Chaos-MCP/commit/9b9c7a93e70716f1b274fd3fc9ca37327a183bd4))
* **args:** reject a non-boolean dryRun or incremental ([c696fe2](https://github.com/AraneaDev/Chaos-MCP/commit/c696fe2b4f0d288f3a9d3b92c77277dfaf224fb9))
* close 48 logic-audit findings across all four fronts ([8a71a96](https://github.com/AraneaDev/Chaos-MCP/commit/8a71a961657f6a31bcd8a1546006665587567ec0))
* comprehensive audit findings and container execution fixes ([6472f03](https://github.com/AraneaDev/Chaos-MCP/commit/6472f03a6c3a540c3e5468f069ad138b782ecf4f))
* **container:** give Vite a writable scratch inside node_modules ([a3d459e](https://github.com/AraneaDev/Chaos-MCP/commit/a3d459e950db8f5a422e3b5912127688db559d39))
* **container:** reclaim containers on process exit, and make dispose retryable ([7975cb4](https://github.com/AraneaDev/Chaos-MCP/commit/7975cb484f8e5945cf97eab8253f1b168aaa8847))
* **containers:** install procps so the engines can spawn ps ([6b40fc8](https://github.com/AraneaDev/Chaos-MCP/commit/6b40fc8ec23f84df73d12b83ed7ba59509b87352))
* decompose the god modules and close the structural audit findings ([b718cce](https://github.com/AraneaDev/Chaos-MCP/commit/b718ccea464427ebadb81280d047bc1cb2c81b28))
* **engines:** preserve the ABORTED marker in the TypeScript and Rust engines ([60b06e5](https://github.com/AraneaDev/Chaos-MCP/commit/60b06e55eb311c6999ef11f0cdae5de04f7373cb))
* **enrich:** detect exhaustiveness guards written without braces ([c6b237e](https://github.com/AraneaDev/Chaos-MCP/commit/c6b237e69dd8e6c4939c4ea93377e2cb910c6031))
* **enrich:** stop advising a test for mutants that cannot be killed ([421ac3d](https://github.com/AraneaDev/Chaos-MCP/commit/421ac3d2ff8aac22edc2ca353d92bffce167c514))
* **estimate:** escape the cargo-mutants file glob ([7586a82](https://github.com/AraneaDev/Chaos-MCP/commit/7586a82f107bd050aa2494b9957445f1c9fa67ae))
* **format:** explain an empty report when severityFloor hid everything ([8341137](https://github.com/AraneaDev/Chaos-MCP/commit/834113760e3470b537b1afb1a624fc8edb959135))
* **format:** never claim "caught every mutation" when zero mutants ran ([6c8792d](https://github.com/AraneaDev/Chaos-MCP/commit/6c8792dd1eb71cea31b8666a0fba285368a44d81))
* four small correctness and consistency gaps ([5700bde](https://github.com/AraneaDev/Chaos-MCP/commit/5700bde542c14029d364794252a11d9c4cef355e))
* **lint:** satisfy array-type, and repoint a moved cross-reference ([29b2f07](https://github.com/AraneaDev/Chaos-MCP/commit/29b2f07490ac9ab9ec175b85f5a9a1cb0a59e776))
* **php:** read Infection's real `uncovered` key, not `notCovered` ([abd529c](https://github.com/AraneaDev/Chaos-MCP/commit/abd529cc10b0fb587da3b1fdde5348b9985a6d3b))
* **schema,cli:** align the advertised contract with what the runtime actually does ([56f833d](https://github.com/AraneaDev/Chaos-MCP/commit/56f833dec5d3825267690449970f60baddee5994))
* **tests:** restore the test suite to type-checking ([6fde32a](https://github.com/AraneaDev/Chaos-MCP/commit/6fde32aff54b69a85669045c244c5ddfea054dd2))
* **triage:** discover exactly the files an audit accepts ([2fb2a1f](https://github.com/AraneaDev/Chaos-MCP/commit/2fb2a1f2495d04f2bb0f016d383abc8252594064))
* **triage:** honour cancellation after the pool, and re-read the budget after provisioning ([5157ab0](https://github.com/AraneaDev/Chaos-MCP/commit/5157ab0a2a0d4960159e335bb6f30bc080df313d))
* **verify:** stop inferring mutant state the run never actually measured ([402cac1](https://github.com/AraneaDev/Chaos-MCP/commit/402cac16b903d3627dd585dce5f19adc1f00d86e))
* **verify:** stop line-scoping the re-run, which reported untested mutants as killed ([4de8fd7](https://github.com/AraneaDev/Chaos-MCP/commit/4de8fd72bb6ee743af1b70b98a13b18f1d7c2c3b))


### Performance Improvements

* **sandbox:** make the workspace size walk async so aborts are observable ([b221a9c](https://github.com/AraneaDev/Chaos-MCP/commit/b221a9cc9cc45f972bb939ba35d7c492cba888a1))

## [1.6.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.5.0...v1.6.0) (2026-07-27)


### Features

* **php:** warn when a project's PHPUnit config makes survivors unreliable ([e5de20f](https://github.com/AraneaDev/Chaos-MCP/commit/e5de20f3f2ae6161c13d5699e93b1e8085b3e003))
* **sandbox:** allow auditing workspaces named in CHAOS_ALLOWED_ROOTS ([482a1ca](https://github.com/AraneaDev/Chaos-MCP/commit/482a1ca2e81acbcb2719576f444683fa4f0b73d4))


### Bug Fixes

* **estimate:** reject a missing target instead of estimating zero mutants ([ee645b4](https://github.com/AraneaDev/Chaos-MCP/commit/ee645b4b570380f4a565962b1e90bba39c11e91f))
* **estimate:** stop counting arrow and member tokens as operators ([b43d6da](https://github.com/AraneaDev/Chaos-MCP/commit/b43d6dab12a667c5acd083776b71289e66e946d6))
* **git-diff:** trim and sort the changed-file list, and pin both ([fb16b10](https://github.com/AraneaDev/Chaos-MCP/commit/fb16b10f1d31ed5fce5eea9295ba1179d686c018))
* **handler:** honour CHAOS_ALLOWED_ROOTS at every tool entry point ([79f8137](https://github.com/AraneaDev/Chaos-MCP/commit/79f8137dc494e7a43b48f8c49547d80fda0c73c3))
* **php:** name the real cause when Infection aborts before logging ([b0f8269](https://github.com/AraneaDev/Chaos-MCP/commit/b0f8269a1bb7179ee84638c9357de8240ee48852))
* **php:** never report a stale Infection log as a fresh result ([b4a0ef0](https://github.com/AraneaDev/Chaos-MCP/commit/b4a0ef0f00a8921a41ff368196eb28739b8428e4))
* **run-cache:** break a createdAt tie by id so eviction is reproducible ([fdea68c](https://github.com/AraneaDev/Chaos-MCP/commit/fdea68c0b41b021d488bca4c2efa3030c9451b80))
* **sandbox:** symlink nested heavyweight directories, not just the root ([0d6be1a](https://github.com/AraneaDev/Chaos-MCP/commit/0d6be1a25fe2b201ded97591b093bac14e05927d))
* **types:** drive test type errors to zero and make the gate hard ([eb3354e](https://github.com/AraneaDev/Chaos-MCP/commit/eb3354eab54c600f8574dec9c0dd8697630ff801))

## [1.5.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.4.0...v1.5.0) (2026-07-24)


### Features

* add containerized mutation engines ([974e0e0](https://github.com/AraneaDev/Chaos-MCP/commit/974e0e0ce5b374944c3f2e279b6024d528a62dcf))
* add containerized mutation engines ([31219e7](https://github.com/AraneaDev/Chaos-MCP/commit/31219e73c9790d618c92255cfec6ac259704dd42))


### Bug Fixes

* address container execution review ([de49439](https://github.com/AraneaDev/Chaos-MCP/commit/de49439c9c8b0479e7a8a33c7cb923b8c5025b4c))

## [1.4.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.3.1...v1.4.0) (2026-07-24)


### Features

* harden mutation audits and CLI execution ([7785640](https://github.com/AraneaDev/Chaos-MCP/commit/7785640b6c6ab014654ad3f24d3a9dc807eee0b1))


### Bug Fixes

* address review timeout and portability issues ([18455df](https://github.com/AraneaDev/Chaos-MCP/commit/18455df4883f93dc6d79d40fef7f7cefc1641ba2))

## [1.3.1](https://github.com/AraneaDev/Chaos-MCP/compare/v1.3.0...v1.3.1) (2026-07-19)


### Bug Fixes

* **python:** bound test discovery without falsely reporting no tests ([4a183e7](https://github.com/AraneaDev/Chaos-MCP/commit/4a183e7741fce3a575cdd68bb452b64bd5e8db52))
* **python:** fail with a clear message when a project has no tests ([9d341ba](https://github.com/AraneaDev/Chaos-MCP/commit/9d341ba902c11c9b4f461e3467af0083e171af2f))
* **python:** report missing tests accurately instead of blaming a failing suite ([e0387ec](https://github.com/AraneaDev/Chaos-MCP/commit/e0387ec9075a134212d742039b119f1c4c96dece))


### Performance Improvements

* **python:** check for Python tests before creating the sandbox ([4321be8](https://github.com/AraneaDev/Chaos-MCP/commit/4321be8d829e063e81acd87b5f8132caf2638a41))

## [1.3.0](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.4...v1.3.0) (2026-07-18)


### Features

* **detector:** fall back to the command runner for vitest 3 projects ([dcc7a52](https://github.com/AraneaDev/Chaos-MCP/commit/dcc7a52b8bde2d004a6cb7a160b7fbb78a491e35))


### Bug Fixes

* address PR review (Windows npx, empty mutator name, hoisted vitest) ([543cd2f](https://github.com/AraneaDev/Chaos-MCP/commit/543cd2f890c71fbbfae33a017a138a1c375f7b98))
* **php:** report missing PHPUnit config as an unsupported-runner error ([43f7679](https://github.com/AraneaDev/Chaos-MCP/commit/43f7679fcf5a706a3ef2cc300ab593b0da2b9a13))
* **verify:** place Stryker-disable directive on its own line above the loop ([819e4fc](https://github.com/AraneaDev/Chaos-MCP/commit/819e4fce87498591ada9539153a60f6d544061b4))

## [1.2.4](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.3...v1.2.4) (2026-07-10)


### Bug Fixes

* **stryker:** pass runner plugin explicitly so it resolves under pnpm ([#10](https://github.com/AraneaDev/Chaos-MCP/issues/10)) ([b5f7a28](https://github.com/AraneaDev/Chaos-MCP/commit/b5f7a28ac83358707a355bad6924805eb97a40b0))

## [1.2.3](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.2...v1.2.3) (2026-07-10)


### Bug Fixes

* **php:** make Infection mutation testing work end-to-end ([#8](https://github.com/AraneaDev/Chaos-MCP/issues/8)) ([b80983d](https://github.com/AraneaDev/Chaos-MCP/commit/b80983debf4dc4e9bb2f1b10c859445a3e90b72b))
* **rust:** parse cargo-mutants summary line for accurate score ([#6](https://github.com/AraneaDev/Chaos-MCP/issues/6)) ([722c5be](https://github.com/AraneaDev/Chaos-MCP/commit/722c5be557a4bbc46ff7a157123a3e551214c602))

## [1.2.2](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.1...v1.2.2) (2026-07-07)


### Bug Fixes

* **typescript-engine:** return a dry-run result instead of failing ([#3](https://github.com/AraneaDev/Chaos-MCP/issues/3)) ([901f94b](https://github.com/AraneaDev/Chaos-MCP/commit/901f94b7a222d8d536d0e206c9b51c0ef724273d))
* unify cancellation surface, fix WRITE_QUEUE leak, harden prompts + Stryker cleanup ([#5](https://github.com/AraneaDev/Chaos-MCP/issues/5)) ([b492324](https://github.com/AraneaDev/Chaos-MCP/commit/b492324c8343c93e03266252f2b98851b51cbf83))

## [1.2.1](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.0...v1.2.1) (2026-07-05)


### Bug Fixes

* apply CodeRabbit auto-fixes ([9bd58a4](https://github.com/AraneaDev/Chaos-MCP/commit/9bd58a4a5e7bead093d4f4c129f5ef774829c533))
* **config,cli:** validate infection/cosmicray keys; guard --config flag-value (M2/L2) ([5fbbc39](https://github.com/AraneaDev/Chaos-MCP/commit/5fbbc399a5d70282f63999f6d62c721290fb362c))
* **engines:** derive rust mutator from description; keep php counts consistent (H2/I4/L5) ([6f49f0e](https://github.com/AraneaDev/Chaos-MCP/commit/6f49f0e2192dcc5a5e0dae3a9534c3e55b72bf43))
* **handler,exec:** per-engine ignored-options, abort classification, outputFormat/unknown-tool as toolError (M1/M5/L4/I1) ([7954f88](https://github.com/AraneaDev/Chaos-MCP/commit/7954f8871f9d4bd469af8cefe177d7b9d69929f7))
* resolve 20 logic-audit findings (H/M/L/I) ([8e5cb70](https://github.com/AraneaDev/Chaos-MCP/commit/8e5cb70dfd2b13344da9cedad36e80a9c1de28da))
* **triage,format,schema:** n/a honesty + shared helper, richer schemas, shared timeout, surface incompetent, line-sentinel warning (M3/M6/L6/L7/I2/I3) ([9062a5f](https://github.com/AraneaDev/Chaos-MCP/commit/9062a5f75cca869e85f2da3ab8744bc283ee7a87))
* **utils:** sandbox leak on cwd-guard, run-cache tmp cleanup, addSuppressions array guard (M4/L3/L1) ([7a2b9fb](https://github.com/AraneaDev/Chaos-MCP/commit/7a2b9fb2d45d5a71e105bf67e3cb9b0d7daec72c))
* **verify:** count out-of-baseline regressions for whole-file engines; emit verify structuredContent (H1/H3) ([7665f03](https://github.com/AraneaDev/Chaos-MCP/commit/7665f030dea6e597445ae950b397a7e7c73fdd79))

## [Unreleased]

### Changed — StrykerJS internal-mutation bootstrap parked

- **`@stryker-mutator/*` devDeps uninstalled.** The chaos-mcp-internal mutation-testing bootstrap (the `mutate` script + `stryker.config.mjs`) was parked because the only currently-published Stryker runners are stuck on vitest 2.x and vitest 3.0 dropped the `--related` / `config.related` programmatic API both `@stryker-mutator/vitest-runner@9.6.1` and the (unpublished) `@stryker-mutator/command-runner@9.x` relied on. StrykerJS 10.x has not shipped yet (npm latest is still 9.6.1), so the only realistic revival path is a temporary vitest downgrade. The user-facing STRYKER-ONLY_OPTIONS, `stryker` config section, and `ExecutableTool` enum entries are preserved unchanged — users who install Stryker locally on their target workspace can still invoke `audit_code_resilience` with their own Stryker configuration.
- **`stryker.config.mjs`** — tombstoned with `mutate: []` (explicit empty scope) and full resurrection steps A/B/C documented in the file header. Since `@stryker-mutator/*` devDeps are uninstalled at HEAD, this file is effectively documentation-only: `npx stryker run` is unreachable from the project's normal usage paths because the binary is not in `node_modules`. (If Stryker is later re-installed for resurrection work, this config WILL load — but Stryker 9.6's dry-run phase runs BEFORE mutation processing and would still fail with the same `ConfigError: No tests were executed` that prompted the park. The empty scope only guards the mutation-side-effects, not enumeration. See the in-file header + `docs/stryker-mutation-testing-retrospective.md`.)
- **`scripts/install.sh` / `package.json` scripts** — the `mutate` npm script was removed; `npm run mutate` is no longer wired.
- **`src/__tests__/e2e-stryker.test.ts`** — deleted. It had top-level `import { Stryker } from '@stryker-mutator/core'` and the package is no longer present in `node_modules` (Vite's module loader would fail at file-load time otherwise). The Sibling `e2e-mcp.test.ts` covers the integration regression scenarios.
- **`CONTRIBUTING.md`** — removed the now-stale local-invocation block for `e2e-stryker.test.ts` and the "What gets exercised" Stryker bullet. The remaining `When to trigger an E2E run` entry still mentions Stryker because users commonly upgrade their own Stryker installation (the `npm install --save-dev @stryker-mutator/core` in `README.md` is unchanged for that reason).
- **Path B (vitest@2.x downgrade) attempted and ruled out.** A side branch `feat/stryker-vitest2` pinned `vitest@^2.1.0` + `@stryker-mutator/{core,vitest-runner}@^9.6.1` and re-installed the `mutate` script + a revival `stryker.config.mjs` to attempt the F1 baseline. The dry-run STILL FAILED on vitest@2.x with `ConfigError: No tests were executed` — same wall as on vitest@3.x. StrykerJS 9.6's vitest-runner appears incompatible with this project's `vitest.config.ts` regardless of vitest major, likely due to its `tests/global-setup.ts` rebuild block + include-glob resolution interacting with Stryker's `--related` lookup. Attempt rolled back on the side branch (which is force-pushed to origin and preserved as a documentation tombstone); awaiting StrykerJS 10.x or a vitest3→runner shim (Path C) before any future revival attempt.

### Fixed — `isCancel` regression coverage + cancellation surface unification

- **`src/utils/cancel.ts` (new)** — single `isCancel(error, ctx?)` predicate covers all three cancellation shapes (`ctx.signal.aborted === true`, `error.name === 'AbortError'`, `ExecFailureError.code === 'ABORTED'`). Replaces ad-hoc duplicates in `handler.ts`, `estimate-handler.ts`, and `triage-handler.ts` that had drifted apart (audit C1 followup).
- **`src/__tests__/cancel.test.ts` (new)** — 17 cases across all three branches plus negative interactions.
- **`handler.ts`** — `mapCreateSandboxError` accepts an optional ctx, both create-sandbox and engine catch arms route via `isCancel`.
- **`estimate-handler.ts`** — outer catch routes cancellation to `'Operation cancelled.'` instead of `'Chaos Engine Halted: …'`.
- **`triage-handler.ts`** — per-row `createSandbox` rejection and `auditOne` outer catch both route via `isCancel`.

### Fixed — `WRITE_QUEUE` leak in `suppression.ts`

- Both halves of the cleanup invariant fixed: the chained **`Promise` identity** used to compare unequally in the `.finally` delete step (always leaked a dead reference per workspace per write), and the **return value** was the un-cleaned `next` so callers resumed before cleanup ran. Now the post-cleanup promise is returned and the cleanup comparator matches the actual stored identity.

### Fixed — backtick-fence bypass in `prompts.ts`

- `quoteUserValue` regex now escapes **every** backtick (not just literal 3-backtick sequences). A user-supplied value with 4+ backticks could previously escape the surrounding fenced code block.

### Fixed — cli-* baseline rebuild race via vitest `globalSetup`

- **`tests/global-setup.ts` (new)** + **`vitest.config.ts`** — `globalSetup` rebuilds `./build/index.js` only when missing or when a tracked production source is newer (mtime-gated via `git ls-files` pathspec skip). Skips rebuilds under Stryker (`STRYKER_*` env-var guard — moot now that Stryker is parked, but the guard harmlessly idle-skips). Cleared the recurring `cli-version`, `cli-help`, `cli-smoke`, `cli-validate-config` baseline failures.

### Tests

- **`src/__tests__/suppression.test.ts`** — concurrent stress test (H3): `Promise.all([add, add, add, remove, add, add, add])` on the same workspace key returns the expected merged state and `_writeQueueSize() === 0` after the chain settles.

## [1.2.0] - 2026-07-04

### Fixed — `mutatorDenylist` had no effect on StrykerJS

- **The denylist config shape was invalid** — `writeStrykerMutatorConfig` wrote a top-level `mutators: { Name: false }` map, which is not a StrykerJS option; Stryker silently ignored it and denylisted mutators kept running. The config now writes the schema-valid `mutator.excludedMutations: [...]` array, merging (deduped) with any exclusions already present in the project's own `stryker.config.json`. A legacy `mutators` map found in an existing config is migrated into `excludedMutations` and the invalid key is dropped.
- **`Ignored` mutants are excluded from the score** — Stryker reports excluded mutants with status `Ignored`; `parseReport` previously counted them in the denominator (deflating the score once the denylist actually worked). They now leave the total, matching the existing CompileError/RuntimeError handling.

### Fixed — actionable error when no tests cover the target

- A StrykerJS dry run that executes zero tests (`ConfigError: No tests were executed`) previously surfaced as a raw exit-1 stack dump. It now reports: the file appears to be covered by no tests, with a pointer to add a test file or check the runner configuration.

### Added — recursive test-file discovery for `suggestedTestFile`

- `suggestTestFile` only probed a fixed candidate list (co-located, `__tests__` sibling, top-level `test/`/`tests/`), so nested layouts like `tests/unit/<pkg>/<base>.test.ts` reported `exists: false` with a wrong suggested path even when a test file existed. When no fixed candidate exists, the common test roots (`tests/`, `test/`, `spec/`, `__tests__/`, the target's top-level segment and directory) are now searched recursively (bounded depth/breadth) for a candidate basename. Matches are ranked by shared directory segments with the source file, then by path length, then lexicographically. Rust targets keep the fixed-candidate behaviour (in-file test convention). The recursive walk also skips `dist`, `build`, `coverage`, `target`, `vendor`, `.stryker-tmp`, and `.chaos-mcp`.

### Added — `diffBase` on `triage_test_coverage`

- **`diffBase` argument** — auto-scopes the triage to files changed in git. Accepts `"HEAD"`, `"staged"`, or any git ref/branch/SHA (merge-base with HEAD). `paths` is now optional when `diffBase` is provided: supplying only `diffBase` audits every changed supported source file in the workspace; supplying both intersects changed files under the given paths.
- TypeScript files are mutated only on the changed lines (same line-scoping logic as `audit_code_resilience`). Python, Go, and Rust files always run whole-file; each affected ranking row includes a `scopeNote` field explaining the per-file scoping decision.
- `not-a-repo` and `bad-ref` diff errors are surfaced as clean MCP error responses (not crashes).

### Added — `survivorsPerFile` inline enrichment

- **`survivorsPerFile` argument** (integer ≥ 0; default `0`) — when `> 0`, inlines the top-N severity-ranked, enriched survivor groups directly into each `TriageRow` in the `ranking` array. Fields added to the row when non-empty: `survivors` (grouped by line, enriched), `noCoverageGroups`, `worstSeverity`. Default `0` returns the compact scores-only leaderboard.

### Added — `fileConcurrency` bounded-parallel auditing

- **`fileConcurrency` argument** (integer 1–64; default `max(1, min(4, cpus-1))`) — files are now audited in bounded parallel rather than serially. When `fileConcurrency > 1`, each TypeScript/StrykerJS run's worker count is automatically capped to `floor((cpus-1) / fileConcurrency)` so total CPU use stays near the machine's core count instead of oversubscribing. Other languages (Python/Go/Rust) run whole-file without a worker-count override (they ignore the concurrency cap).
- **`resolveStrykerConcurrency(poolSize, cpuCount)`** — exported helper that computes the per-file Stryker worker cap (returns `undefined` when `poolSize ≤ 1`, i.e. serial mode).

### Added — `structuredContent` + `outputSchema` on `triage_test_coverage`

- **`structuredContent`** is now returned in every `triage_test_coverage` response alongside the text block, matching the behaviour of `audit_code_resilience`. MCP clients can consume the `TriagePayload` directly; the text block is retained for compatibility.
- **`outputSchema`** registered on the `triage_test_coverage` tool definition, describing the `TriagePayload` shape (`mode`, `summary`, `ranking`, `errors`, `scopeNote`, `note`).

### Added — `defaultFileConcurrency` config field

- **`defaultFileConcurrency`** (integer 1–64 in `chaos-mcp.config.json`) — sets the default parallel file count for all `triage_test_coverage` calls. Overridden by the `fileConcurrency` tool argument. Falls back to `max(1, min(4, cpus-1))` when absent.

### Refactored — triage sort-comparator DRY

- Extracted shared `compareTriageRows(a, b)` comparator from the duplicated `scoreNum`/inline-comparator in `triage-handler.ts`. The comparator is now exported from `triage.ts` and reused by both `rankResults` and the handler's final sort. Sort order is byte-identical: score asc, survived desc, file asc.

### Changed — Enrichment on by default

- **`enrich` now defaults to `true`** — survivor/no-coverage groups are enriched and severity-ranked in every audit response unless the caller explicitly passes `"enrich": false`. Prior behaviour (opt-in, off by default) was reversed; callers who relied on unenriched output for token efficiency should now pass `false` to restore it.

### Added — `maxSurvivors` cap

- **`maxSurvivors` tool argument** (integer ≥ 1) — caps how many survivor and no-coverage line groups are returned after severity ranking. Hidden groups are counted in `survivorsTruncated` / `noCoverageTruncated` in the JSON payload. Precedence: `maxSurvivors` arg > `defaultMaxSurvivors` config > 10 (built-in default).

### Added — `severityFloor` filter

- **`severityFloor` tool argument** (`"high"` | `"medium"` | `"low"`) — drops survivor and no-coverage groups whose enriched severity is below the given floor. Dropped groups are counted in `survivorsFiltered` / `noCoverageFiltered`. Requires enrichment (which is on by default); ignored with an explanatory `enrichNote` when `enrich: false` is passed. `"unknown"`-severity groups are treated as below `"low"` and are dropped by any floor.

### Added — `suggestedTestFile` field

- **`suggestedTestFile`** — included in the JSON payload when there are survivors or no-coverage entries (i.e. when the mutation score is below 100%), pointing to the conventional test file path for the audited source file (e.g. `src/utils/__tests__/math.test.ts` for `src/utils/math.ts`). The `exists` field indicates whether the file already exists on disk. Helps the calling agent know where to add or strengthen tests.

### Added — `outputSchema` on the tool definition

- **`outputSchema`** registered on the `audit_code_resilience` tool definition. MCP clients that support it can read the schema to understand the structured payload without parsing JSON from the text block.

### Added — `structuredContent` in the tool response

- **`structuredContent`** is now returned alongside the text content block in every successful (non-verify-mode, non-error) `audit_code_resilience` response. MCP clients can consume the structured payload directly; the text block is retained unchanged for compatibility with clients that read `content[0].text`.

### Added — Go severity support

- **Go mutator name mapping** — `canonicalizeMutator` now maps `<group>/<name>` mutator strings produced by go-mutesting (e.g. `"branch/if"` → `ConditionalExpression`, `"expression/comparison"` → `EqualityOperator`) to canonical severity categories via `GO_MUTATOR_MAP`. The mapping activates unconditionally; it produces severity-ranked output when go-mutesting emits structured data with mutator names, and falls back to `"unknown"` for unmapped names.

### Added — New config fields

- **`defaultMaxSurvivors`** (integer ≥ 1 in `chaos-mcp.config.json`) — sets the default survivor cap for all `audit_code_resilience` calls. Overridden by the `maxSurvivors` tool argument.
- **`defaultSeverityFloor`** (`"high"` | `"medium"` | `"low"` in `chaos-mcp.config.json`) — sets the default severity floor for all `audit_code_resilience` calls. Overridden by the `severityFloor` tool argument.

## [1.1.1] - 2026-06-24

### Added — End-to-End Test Coverage + CI Integration
- **`.github/workflows/e2e.yml`** — new opt-in E2E workflow. Triggers on `workflow_dispatch` (manual) OR `pull_request` labeled with `run-e2e`. Runs the full E2E suite (MCP audit pipeline + Stryker mutations). The `if:` condition gates on `github.event.action == 'labeled'` (not just label presence) to prevent spurious re-runs when a maintainer removes or re-edits the label.
- **`src/__tests__/e2e-mcp.test.ts`** — real MCP audit pipeline E2E against a fixture. Spawns the server as a child process via full-stdio JSON-RPC, exercises the `audit_code_resilience` tool end-to-end against a real workspace. Leak detector is snapshot-relative (captures tmpdir contents in `beforeAll`, only flags dirs created *by this run*) so prior runs and parallel processes don't produce false positives.
- **`src/__tests__/e2e-stryker.test.ts`** — real StrykerJS programmatic mutation test. Builds a temp fixture with a `divide()` function (intentional untested `b === 0` branch for kill-vs-survive mix), symlinks host `node_modules` so no `npm install` is needed in CI, invokes `new Stryker({ testRunner: 'vitest', ... }).runMutationTest()` and asserts at least one mutant killed + one surviving + a mutation score strictly between 0% and 100%. Has install-version detection that prints a `console.error` and skips if `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` major versions are misaligned.

### Added — L3 Negative-Arm Regression Coverage
- **`src/__tests__/exec-error-l3.test.ts`** — regression test for the L3 fix (execFile TIMEOUT classification must require `killed === true` to distinguish real timeouts from external SIGTERM). Covers BOTH arms: positive (real timeout produces a TIMEOUT code) and negative (synthetic `(code: null, signal: 'SIGTERM', killed: false)` error must NOT be classified as TIMEOUT). Uses `vi.mock` + `vi.hoisted` (the ESM-safe pattern; `vi.spyOn` fails at runtime because Node ESM module exports are read-only).

### Changed — Stryker Major Alignment
- `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` both bumped to v9.6.1 (were `^8.7.0` + `^9.6.1` mismatched). Allows `e2e-stryker.test.ts` to actually execute mutations in CI instead of skipping. TypeScript engine JSON parser handles Stryker v9's `mutation.json` schema identically (status / mutatorName / replacement / location.start.line) — no parser change required.

### Changed — Tightened Test Lint Rules
- Added `eslint-plugin-vitest` to `eslint.config.js` with two rules: `vitest/consistent-test-it` (enforces `it` consistency across the suite) and `vitest/no-conditional-expect` (forbids conditional assertions inside test bodies).

### Fixed — Test Suite Hygiene
- **`src/__tests__/exec-error.test.ts`** — removed the broken `vi.spyOn(cp, 'execFile')` block (which threw `TypeError: Cannot spy on export "execFile". Module namespace is not configurable in ESM` at runtime) and the duplicated L3 positive-arm test. File is now C1-regression-only.

### Docs
- **CONTRIBUTING.md** — added "End-to-End Testing" section documenting the two trigger paths (`workflow_dispatch` + `run-e2e` label), local invocation env vars (`E2E=1`, `E2E_STRYKER=1`), what each E2E test exercises, and when to trigger an E2E run.

## [1.1.0] - 2026-06-24

### Added — Engine Optimization
- **Async `runShell` helper** (`src/utils/exec.ts`) — promisified `execFile` with `ExecFailureError` class capturing stdout/stderr, exit code, signal, and ENOENT/timeout normalization. Replaces all `execSync` calls (was blocking the event loop for up to 5 min per mutation run).
- **`concurrency` option** — wired into StrykerJS `--concurrency` flag (was declared but never passed through). Tool args override config defaults.
- **Timeout mutants count as killed** — both TypeScript (Stryker) and Python (mutmut) engines now count `Timeout` status mutants as killed, consistent with Stryker's own mutation score semantics.

### Fixed — Engine Optimization
- **Python engine result parsing** — rewrote to parse `mutmut results` text output (emoji category headers + indented IDs) instead of nonexistent `mutmut json` subcommand. The entire previous parsing path was fictional.
- **Python engine baseline failures** — `mutmut run` exits 0 even when mutants survive; non-zero exit now surfaces as a baseline-test-failure error instead of being swallowed.
- **Python engine mutmut v3 compatibility** — changed from `--paths-to-mutate` flag (v2) to positional arg pattern (v3).
- **Go/Rust empty-stdout guard** — `!stdout` check prevents misleading 100% scores when go-mutesting/cargo-mutants crash with stderr only.
- **Go/Rust stderr capture** — crash messages now include stderr content for diagnostics.
- **TypeScript exit code distinction** — Stryker exit 1 (config error) vs exit 2 (threshold not met) are now distinguished; exit 1 throws, exit 2 proceeds to report parsing.
- **TypeScript defensive catch-all** — non-`ExecFailureError` errors no longer silently fall through to `parseReport`.

### Added — Area 2: Environment Auto-Detection
- **Go test runner detection** — `detectGoTestRunner()` detects testify and ginkgo via `go.mod` dependencies. `detectRawGoRunner()` returns the unmapped value.
- **Rust test runner detection** — `detectRustTestRunner()` detects cargo-nextest (via `nextest.toml` or `.config/nextest.toml`) and criterion benchmarks (via `Cargo.toml`). `detectRawRustTestRunner()` returns the unmapped value.
- **bun.lockb detection** — added as a signal for bun test runner detection.
- **Python venv detection** — `.venv/` and `venv/` directories detected and symlinked into sandbox.
- `detectEnvironment()` updated to use the new Go/Rust detection instead of hardcoded `'go test'` / `'cargo test'`.

### Added — Area 3: Sandbox Isolation
- **`os.tmpdir()`** — replaces hard-coded `/tmp` for cross-platform temp directory support (TMPDIR on macOS/Linux, TEMP/TMP on Windows).
- **Symlink heavyweight directories** — `node_modules`, `.venv`, `venv`, and `target/` are symlinked into the sandbox instead of copied (were previously copied in full or excluded entirely).
- **Windows junction fallback** — `safeSymlink()` tries `symlinkSync('dir')` first, falls back to `symlinkSync('junction')` on Windows when symlinks require admin privileges.
- **Workspace size guard** — warns when workspace exceeds 200MB (verbose mode only, to avoid traversal overhead in normal mode).
- **`ignorePatterns` in sandbox** — user-provided substring patterns are merged into the `cpSync` filter alongside built-in `ALWAYS_EXCLUDE`.
- **`target` added to `ALWAYS_EXCLUDE`** — Rust build artifacts no longer copied.

### Added — Area 4: Tool Schema Extensions
- **`dryRun`** (boolean, StrykerJS only) — validates the test suite passes without mutation testing. Wired to `--dryRun` flag.
- **`outputFormat`** (`'json'` | `'text'`) — `'text'` returns a human-readable summary via `formatResultAsText()`. Default is `'json'`.
- **`incremental`** (boolean, StrykerJS only) — reuses results from a previous run to skip unchanged mutants. Wired to `--incremental` and `--incrementalFile` flags.
- **`ignorePatterns`** (string[]) — substring patterns to exclude files/directories from the sandbox copy.
- **`additionalProperties: false`** — added to tool input schema for MCP compliance.

### Added — Area 5: Deployment & Packaging
- **GitHub release workflow** (`.github/workflows/release.yml`) — tag-triggered CI that builds, tests, and publishes to npm.
- **Shebang preservation** — `postbuild` script prepends `#!/usr/bin/env node` to `build/index.js` (tsc strips shebangs) and sets execute permissions (guarded by platform check for Windows).
- **`prepare` script** — runs build on `npm install` for git dependencies.
- **`prepublishOnly` script** — runs `build` + `check` (build, lint, format check, test) before publishing.
- **`engines` field** — `node >=18.0.0` enforced in package.json.

### Changed — ESLint Configuration
- Switched from `projectService` (with file-count limit) to `project: 'tsconfig.eslint.json'` to resolve "Too many files (>8) matched default project" error.

### Tests
- All 4 engine test files rewritten to mock `runShell`/`ExecFailureError` (ESM-safe top-level imports).
- New `mutmut-parser.test.ts` — unit tests for `parseMutmutResults` covering empty output, missing emoji, suspicious mutants, mixed categories, and v3 numeric IDs.
- Added timeout-status mutant test cases to TypeScript engine tests.
- Added Go/Rust runner detection tests to `project-detector.test.ts`.
- Added `dryRun`, `incremental`, `concurrency`, `ignorePatterns`, and `outputFormat` wiring tests to `handler.test.ts`.
- Added E2E integration test verifying server accepts all new schema options in `tools/call`.
- Fixed pre-existing outdated test (`main.rs` was listed as unsupported but Rust support was already added).
- Updated sandbox tests for `os.tmpdir()`, new symlinks, and `ignorePatterns`.
- Updated integration tests for new schema properties and `additionalProperties: false`.

### Added — Audit-Driven Hardening (`LOGIC-AUDIT.md` + `LIVE-AUDIT.md`)
- **`invokeMutationTool` wrapper** (`src/utils/exec-classify.ts`) — new module centralises startup-failure classification (ENOENT / timeout / signal crash) so each engine's catch block shrinks from ~25 lines of duplicated scaffolding to a single instance check. Eliminated the duplication that allowed audit finding C1 (`err.status` vs `err.code`) to propagate to all 4 engines.
- **`ExecFailureError.exit` reads `err.code`** (`src/utils/exec.ts`) — numeric exit codes are now correctly reported instead of always-null. Fixes Stryker exit-1 (config error) detection, Mutmut baseline-failure detection, and all `cargo mutants` / `go-mutesting` exit-code branches (audit C1).
- **`C2` path-traversal guards** — handler-level check refuses `filePath` values whose `resolve(cwd, …)` escapes `cwd`; defense-in-depth check in `createSandbox` throws `Refusing to sandbox workspace outside process cwd` when `workspaceRoot` itself escapes `cwd`. Defends against an LLM being tricked into auditing host files outside the workspace (audit C2).
- **`H1` Rust `target/` no longer symlinked** — Rust builds compile into a sandbox-local `target/`, leaving the host workspace's build cache intact (audit H1).
- **`H2` Go baseline-failure detection** — when `go-mutesting` exits non-zero with zero parsed mutants, the engine now throws a baseline-failure error rather than silently reporting a fake 100% mutation score. Parser requires quoted paths on PASS/FAIL lines to distinguish mutants from baseline compiler-error output (audit H2).
- **`H3` Rust TIMEOUT mutants counted as killed** — both TypeScript (Stryker) and Rust (cargo-mutants) engines count `Timeout` mutants as killed, consistent with Stryker's own semantics (audit H3).
- **`H4` Python header / path disambiguation** — `parseMutmutResults` now requires a category emoji OR a parens-counted header line, AND rejects lines that look like file paths. Prevents mutant IDs like `survived_logic.py:7` from being misclassified as section headers (audit H4).
- **`H5` concurrency validation** — `concurrency` must be an integer between 1 and 64 (Stryker worker cap). Non-integer / out-of-range values produce a clear MCP error (audit H5).
- **`M1` `CompileError` / `RuntimeError` excluded from mutation score** — Stryker mutants with these statuses don't have a testable outcome; counting them in `total` would inflate scores (audit M1).
- **`M2` `NoCoverage` mutants reported as vulnerabilities** — no test reached that code path; surfaced as first-class vulnerabilities with a dedicated description (audit M2).
- **`M5` `lineScope` validation** — must be `{ start: integer ≥ 1, end: integer ≥ start }`. Invalid values are rejected (audit M5).
- **`M6` segment-based `ignorePatterns` matching** — replaces substring matching so a pattern `test` doesn't over-eagerly exclude `latest.ts` (audit M6).
- **`M7` `ignorePatterns` element-type check** — non-string array elements no longer silently filtered out (audit M7).
- **`M8` `TOOL_DEFINITION` doc fix** — corrected schema descriptions to match actual behaviour (audit M8).

### Fixed — Live-Audit (`LIVE-AUDIT.md`)
- **`L1`** — `createSandbox` no longer refuses the legitimate case where `workspaceRoot === process.cwd()` (the most common case in real usage). The `isPathInside` helper now mirrors the handler's version.
- **`L2`** — `ignorePatterns` with trailing separator (`["fixtures/"]`) is now normalised before segment matching, so the most common user convention works as expected.
- **`L3`** — execFile TIMEOUT classification now requires `killed === true`, distinguishing real timeouts from external SIGTERM (e.g. OOM killer).
- **`L4`** — `parseCargoMutantsText` now case-insensitively matches `timeout`, so lowercase outputs from `cargo mutants` text mode are correctly counted.
- **`L5`** — dismissed after fact-check; the quoted-path gate on the go parser is intentional (preserves the H2 baseline-failure detection).

## [1.0.0] - 2024-06-24

### Added
- **`audit_code_resilience`** MCP tool — on-demand, sandbox-isolated mutation testing
- **TypeScript/JavaScript engine** — StrykerJS integration with programmatic API
- **Python engine** — Mutmut CLI integration with JSON output parsing
- **Go engine** — go-mutesting CLI integration with text + JSON output parsing
- **Sandbox isolation** — all mutation runs execute in temp directories; real workspace never touched
- **Environment auto-detection** — vitest, jest, mocha, jasmine, bun, node:test, pytest, tox, nox
- **Tool schema extensions** — `timeoutMs`, `lineScope`, `mutatorAllowlist`, `mutatorDenylist`
- **Configuration file support** — `chaos-mcp.config.json` for default timeout, mutators, test runner
- **CLI flags** — `--version`, `--help`, `--config`
- **Integration test suite** — spawns MCP server as child process, validates JSON-RPC protocol
- **Package metadata** — npm `files`, `engines`, `prepublishOnly`, `keywords`, `license`
