@echo on

REM The Rust binary embeds the web client from dist\client
call npm ci --ignore-scripts
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1

REM aws-lc-sys needs clang-cl to assemble its ARM64 sources; conda-forge sets CC to cl.exe
if "%target_platform%"=="win-arm64" set AWS_LC_SYS_CC=clang-cl

set CARGO_PROFILE_RELEASE_STRIP=symbols
cargo install --locked --no-track --bins --root "%LIBRARY_PREFIX%" --path crates\diffle
if errorlevel 1 exit /b 1

REM Pixi: prevent CONDA_PREFIX from leaking into sandboxed processes
set "MARKER_DIR=%PREFIX%\etc\pixi\diffle"
if not exist "%MARKER_DIR%" mkdir "%MARKER_DIR%"
type nul > "%MARKER_DIR%\global-ignore-conda-prefix"
