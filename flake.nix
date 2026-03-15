{
  description = "Nix flake for building the Vesper server and web client";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        lib = pkgs.lib;
        nodejs = pkgs.nodejs_20;
        beamPackages = pkgs.beamPackages;
        version = "0.1.0";

        server = beamPackages.mixRelease {
          pname = "vesper-server";
          inherit version;
          src = ./server;
          mixEnv = "prod";
          mixFodDeps = beamPackages.fetchMixDeps {
            pname = "vesper-server-deps";
            inherit version;
            src = ./server;
            hash = "sha256-6I69X2RKQ/PjBOd2TpKcHHfIdxMropmTy1lUP85cZes=";
          };
          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.which
          ];
          buildInputs = [
            pkgs.openssl
            pkgs.openssl.dev
            pkgs.srtp
            pkgs.srtp.dev
          ]
          ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.libiconv ];
        };

        web = pkgs.buildNpmPackage {
          pname = "vesper-web";
          inherit version;
          src = ./client;
          inherit nodejs;
          npmDepsHash = "sha256-I6XXD15i+Xep/ROM5uClxLzj9T5/0ntZFc38xvm3AWE=";
          npmBuildScript = "build:web";
          env = {
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/vesper-web
            cp -r dist-web/. $out/share/vesper-web/
            runHook postInstall
          '';
        };

        bundle = pkgs.runCommand "vesper-${version}" { } ''
          mkdir -p $out
          ln -s ${server} $out/server
          ln -s ${web} $out/web
        '';

        serverApp = pkgs.writeShellApplication {
          name = "vesper-server";
          runtimeInputs = [ server ];
          text = ''
            export PHX_SERVER=true
            exec ${server}/bin/vesper "$@"
          '';
        };

        webApp = pkgs.writeShellApplication {
          name = "vesper-web";
          runtimeInputs = [
            pkgs.python3
            web
          ];
          text = ''
            port="''${PORT:-8080}"
            exec ${pkgs.python3}/bin/python -m http.server "$port" \
              --directory ${web}/share/vesper-web
          '';
        };
      in
      {
        packages = {
          default = bundle;
          inherit server web;
        };

        apps = {
          default = {
            type = "app";
            program = "${serverApp}/bin/vesper-server";
          };
          server = {
            type = "app";
            program = "${serverApp}/bin/vesper-server";
          };
          web = {
            type = "app";
            program = "${webApp}/bin/vesper-web";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            beamPackages.elixir
            beamPackages.erlang
            beamPackages.hex
            beamPackages.rebar3
            nodejs
            pkgs.pkg-config
            pkgs.openssl
            pkgs.postgresql
            pkgs.srtp
          ]
          ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.libiconv ];
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
