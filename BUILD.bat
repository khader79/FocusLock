@echo off
echo ========================================
echo  FocusLock - Build Script
echo ========================================
echo.

REM Check for gradlew
if exist gradlew.bat (
    echo Found gradlew.bat - building...
    gradlew.bat assembleRelease
    goto :checkResult
)

if exist gradlew (
    echo Found gradlew - building...
    ./gradlew assembleRelease
    goto :checkResult
)

echo.
echo ERROR: Gradle wrapper not found!
echo.
echo OPTIONS TO BUILD:
echo.
echo 1. ANDROID STUDIO (Easiest):
echo    - Open Android Studio
echo    - File > Open > Select this folder
echo    - Wait for sync
echo    - Build > Build Bundle(s) / APK(s) > Build APK(s)
echo.
echo 2. INSTALL GRADLE FIRST:
echo    - scoop install gradle
echo    - gradle wrapper
echo    - gradlew.bat assembleRelease
echo.
echo 3. GITHUB ACTIONS (Cloud - No install needed):
echo    - Push this folder to GitHub
echo    - Go to Actions tab > "Build FocusLock APK" > Run workflow
echo    - Download APK from Artifacts
echo.
echo 4. DOWNLOAD PREBUILT (if available):
echo    - Check Releases on GitHub
echo.
pause
exit /b 1

:checkResult
if %errorlevel% neq 0 (
    echo.
    echo BUILD FAILED!
    echo Check errors above.
    pause
    exit /b %errorlevel%
)

echo.
echo ========================================
echo  BUILD SUCCESSFUL!
echo ========================================
echo.
echo APK location: app\build\outputs\apk\release\app-release.apk
echo.
echo Next steps:
echo 1. Install APK on device
echo 2. Settings > Accessibility > FocusLock Content Blocker > ON
echo 3. Settings > Network > Private DNS > family.adguard-dns.com
echo.
pause