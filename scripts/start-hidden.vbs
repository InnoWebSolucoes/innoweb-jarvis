' Starts the Jarvis server with no window (used at Windows start-up).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = dir
sh.Run "cmd /c node --no-warnings server.mjs >> data\server.log 2>&1", 0, False
