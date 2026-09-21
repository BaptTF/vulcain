{
  description = "Vulcain development shell (Node 22 + Playwright Chromium)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          playwrightVersion = pkgs.playwright-driver.version;
          playwrightBrowsers = pkgs.playwright-driver.selectBrowsers {
            withFirefox = false;
            withWebkit = false;
            withFfmpeg = false;
          };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              python3
              gnumake
              gcc
              pkg-config
              git
            ];

            env = {
              PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
              PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
            };

            shellHook = ''
              echo "vulcain: node $(node -v), playwright browsers ${playwrightVersion} (nixpkgs)"
              if [ -f test/ui/node_modules/playwright/package.json ]; then
                pw_npm=$(node -p "require('./test/ui/node_modules/playwright/package.json').version" 2>/dev/null || true)
                if [ -n "$pw_npm" ] && [ "$pw_npm" != "${playwrightVersion}" ]; then
                  echo "warning: test/ui playwright ($pw_npm) != nixpkgs ($playwrightVersion); pin test/ui to ${playwrightVersion}"
                fi
              fi
            '';
          };
        }
      );
    };
}
