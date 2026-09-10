@echo off

call npm version patch --no-git-tag-version
if errorlevel 1 (
    echo Version update failed.
    pause
    exit /b 1
)

call npm run package

if errorlevel 1 (
    echo VSIX packaging failed.
    pause
    exit /b 1
)

echo Package created successfully.
pause

