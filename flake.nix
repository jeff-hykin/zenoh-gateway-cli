{
    description = "zenoh-web-cli: the zenoh-web command (zenoh <-> WebRTC bridge for browsers, with the ROS 2 / dimos codecs)";

    inputs = {
        # lib.crossRust (crate2nix + zig) and its nixpkgs / rust-overlay pins, so crates are shared with the other zenoh-web flakes
        zenoh-web.url = "github:jeff-hykin/zenoh-web";
        nixpkgs.follows = "zenoh-web/nixpkgs";
        rust-overlay.follows = "zenoh-web/rust-overlay";
    };

    outputs = { self, zenoh-web, nixpkgs, rust-overlay }:
        let
            lib = nixpkgs.lib;
            pname = "zenoh-web";
            version = "0.4.0";
            darwinX86Target = "x86_64-apple-darwin";

            perSystem = system:
                let
                    # zenoh-web (native), zenoh-web-aarch64-linux, zenoh-web-x86_64-linux: crate2nix, one derivation per crate
                    built = zenoh-web.lib.crossRustPackages { name = pname; inherit system; cargoNix = ./Cargo.nix; };
                    native = built.${pname};
                    pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
                    isDarwin = pkgs.stdenv.hostPlatform.isDarwin;

                    # Intel macOS from Apple Silicon: nixpkgs has no x86_64-darwin anymore, so this one is a plain cargo build
                    # (the same clang/SDK, rustc told the other arch) with vendored crates instead of crate2nix
                    crossX86Darwin =
                        let
                            rustToolchain = pkgs.rust-bin.stable.latest.minimal.override { targets = [ darwinX86Target ]; };
                            rustPlatform = pkgs.makeRustPlatform { cargo = rustToolchain; rustc = rustToolchain; };
                        in pkgs.stdenv.mkDerivation {
                            pname = "${pname}-x86_64-darwin";
                            inherit version;
                            src = lib.cleanSourceWith {
                                src = ./.;
                                filter = path: type: !(lib.hasInfix "/target" path) && !(lib.hasInfix "/test/" path);
                            };
                            cargoDeps = rustPlatform.importCargoLock { lockFile = ./Cargo.lock; allowBuiltinFetchGit = true; };
                            nativeBuildInputs = [ rustToolchain rustPlatform.cargoSetupHook pkgs.nasm pkgs.darwin.autoSignDarwinBinariesHook ];
                            buildPhase = ''
                                runHook preBuild
                                export HOME=$TMPDIR
                                cargo build --release --offline --bin ${pname} --target ${darwinX86Target}
                                runHook postBuild
                            '';
                            installPhase = ''
                                runHook preInstall
                                install -Dm755 target/${darwinX86Target}/release/${pname} $out/bin/${pname}
                                runHook postInstall
                            '';
                            preFixup = ''
                                for library in $(otool -L $out/bin/${pname} | awk '/\/nix\/store\/.*libiconv/ { print $1 }'); do
                                    install_name_tool -change "$library" /usr/lib/libiconv.2.dylib $out/bin/${pname}
                                done
                            '';
                            meta.mainProgram = pname;
                        };

                    # all four release binaries as result/<target-triple>/zenoh-web, plus the release assets:
                    # result/dist/zenoh-web-<version>-<target-triple>.tar.gz (binary + README.md) and SHA256SUMS.
                    # GNU tar in the sandbox: no macOS xattrs/AppleDouble files, fixed owner and mtime.
                    release = pkgs.runCommand "${pname}-release-${version}" { nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ]; } (lib.concatMapStrings (entry: ''
                        install -Dm755 ${entry.package}/bin/${pname} $out/${entry.target}/${pname}
                        mkdir -p staging/${entry.target} $out/dist
                        install -m755 ${entry.package}/bin/${pname} staging/${entry.target}/${pname}
                        install -m644 ${./README.md} staging/${entry.target}/README.md
                        tar --create --format=gnu --no-xattrs --owner=0 --group=0 --numeric-owner --mtime=@1 --sort=name \
                            --directory=staging/${entry.target} ${pname} README.md | gzip -9n > $out/dist/${pname}-${version}-${entry.target}.tar.gz
                    '') [
                        { target = "aarch64-apple-darwin"; package = native; }
                        { target = darwinX86Target; package = crossX86Darwin; }
                        { target = "aarch64-unknown-linux-gnu"; package = built."${pname}-aarch64-linux"; }
                        { target = "x86_64-unknown-linux-gnu"; package = built."${pname}-x86_64-linux"; }
                    ] + ''
                        (cd $out/dist && sha256sum *.tar.gz > SHA256SUMS)
                    '');
                in {
                    packages = built // { default = native; } // lib.optionalAttrs isDarwin {
                        "${pname}-x86_64-darwin" = crossX86Darwin;
                        inherit release;
                    };
                    apps.default = { type = "app"; program = "${native}/bin/${pname}"; };
                };

            outputsBySystem = zenoh-web.lib.eachSystem perSystem;
        in {
            packages = lib.mapAttrs (system: outputs: outputs.packages) outputsBySystem;
            apps = lib.mapAttrs (system: outputs: outputs.apps) outputsBySystem;
            # rust (with the Linux targets), crate2nix, deno
            devShells = zenoh-web.devShells;
        };
}
