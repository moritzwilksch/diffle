{
  description = "Local Git diff reviewer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, self }:
    let
      systems = nixpkgs.lib.systems.flakeExposed;
      forEachSystem = nixpkgs.lib.genAttrs systems;
      package = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          mkDiffle =
            extraRuntimePackages:
            pkgs.buildNpmPackage {
              pname = "diffle";
              inherit (package) version;

              src = pkgs.lib.cleanSourceWith {
                src = self;
                filter =
                  path: type:
                  let
                    name = baseNameOf path;
                  in
                  name != ".git" && name != "dist" && name != "node_modules";
              };

              nodejs = pkgs.nodejs_24;
              # To update: Replace with an emtpy string and run
              # docker run --rm -v "$PWD:/src:ro" -w /src nixos/nix nix build 'path:/src#default' --no-link --extra-experimental-features 'nix-command flakes' 2>&1
              # or in one:
              # hash=$(docker run --rm -v "$PWD:/src:ro" -w /src nixos/nix nix build 'path:/src#default' --no-link --extra-experimental-features 'nix-command flakes' 2>&1 | sed -n 's/.*got: *//p' | tail -1) && test -n "$hash" && sed -i "s|npmDepsHash = \".*\";|npmDepsHash = \"$hash\";|" flake.nix
              npmDepsHash = "sha256-3HfJkuALfPIIK1Y8XM9ECAAsz40cG+yABBYgPKXs40E=";

              nativeBuildInputs = [ pkgs.makeWrapper ];
              postInstall = ''
                wrapProgram "$out/bin/diffle" \
                  --prefix PATH : ${
                    pkgs.lib.makeBinPath (
                      [ pkgs.git ]
                      ++ extraRuntimePackages
                      ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.xdg-utils
                    )
                  }
              '';

              meta = {
                description = "Local Git diff reviewer in the browser";
                homepage = "https://github.com/moritzwilksch/diffle";
                license = pkgs.lib.licenses.asl20;
                mainProgram = "diffle";
              };
            };
        in
        {
          default = mkDiffle [ pkgs.gh ];
          minimal = mkDiffle [ ];
          web = mkDiffle [
            pkgs.gh
            pkgs.typescript-language-server
            pkgs.vscode-langservers-extracted
            pkgs.yaml-language-server
            pkgs.tombi
          ];
          rust = mkDiffle [
            pkgs.gh
            pkgs.rust-analyzer
          ];
          python = mkDiffle [
            pkgs.gh
            pkgs.pyrefly
          ];
        }
      );

      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
