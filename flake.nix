{
  description = "Local Git diff reviewer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    {
      nixpkgs,
      crane,
      self,
    }:
    let
      inherit (nixpkgs) lib;
      systems = lib.systems.flakeExposed;
      forEachSystem = lib.genAttrs systems;
      package = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          craneLib = crane.mkLib pkgs;
          # The browser client, which the binary embeds.
          client = pkgs.buildNpmPackage {
            pname = "diffle-client";
            inherit (package) version;
            src = lib.cleanSourceWith {
              src = self;
              filter =
                path: type:
                let
                  name = baseNameOf path;
                in
                name != ".git" && name != "dist" && name != "node_modules" && name != "target";
            };
            nodejs = pkgs.nodejs_24;
            # Fetches each dependency by the lockfile's integrity hash, so no aggregate hash goes stale on a version bump.
            npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
            npmConfigHook = pkgs.importNpmLock.npmConfigHook;
            npmBuildScript = "build";
            installPhase = ''
              cp -r dist/client "$out"
            '';
          };
          # The Cargo sources plus what build.rs reads: the version from package.json and the
          # wire contract it turns into Rust.
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              (craneLib.fileset.commonCargoSources ./crates)
              ./Cargo.toml
              ./Cargo.lock
              ./package.json
              ./crates/diffle/protocol.generated.json
            ];
          };
          common = {
            pname = "diffle";
            inherit (package) version;
            inherit src;
            strictDeps = true;
          };
          # Dependencies alone, cached across source changes.
          cargoArtifacts = craneLib.buildDepsOnly common;
          unwrapped = craneLib.buildPackage (
            common
            // {
              inherit cargoArtifacts;
              # The release binary embeds dist/client, so the client goes in before cargo runs.
              preBuild = ''
                mkdir -p dist
                cp -r ${client} dist/client
              '';
              # The suites drive git, node and language servers; CI runs them.
              doCheck = false;
              meta = {
                description = "Local Git diff reviewer in the browser";
                homepage = "https://github.com/moritzwilksch/diffle";
                license = lib.licenses.asl20;
                mainProgram = "diffle";
              };
            }
          );
          # The binary with `runtime` on its PATH: git always, gh for pull requests, and the
          # language servers `withLsps` adds. Each result can take more.
          wrap =
            runtime:
            pkgs.symlinkJoin {
              name = "diffle-${package.version}";
              paths = [ unwrapped ];
              nativeBuildInputs = [ pkgs.makeWrapper ];
              postBuild = ''
                wrapProgram "$out/bin/diffle" --prefix PATH : ${lib.makeBinPath runtime}
              '';
              passthru = {
                inherit unwrapped;
                withLsps = servers: wrap (runtime ++ servers);
              };
              inherit (unwrapped) meta;
            };
          base = [ pkgs.git ] ++ lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.xdg-utils;
          default = wrap (base ++ [ pkgs.gh ]);
        in
        {
          inherit default unwrapped;
          minimal = wrap base;
          web = default.withLsps [
            pkgs.typescript-language-server
            pkgs.vue-language-server
            pkgs.astro-language-server
            pkgs.vscode-langservers-extracted
            pkgs.tailwindcss-language-server
            pkgs.yaml-language-server
            pkgs.tombi
          ];
          rust = default.withLsps [ pkgs.rust-analyzer ];
          python = default.withLsps [ pkgs.pyrefly ];
          csharp = default.withLsps [ pkgs.roslyn-ls ];
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
