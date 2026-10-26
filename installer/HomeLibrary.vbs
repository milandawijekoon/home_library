' Starts Home Library without a console window. Installed next to node.exe and app\.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\HomeLibrary"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
cmd = "cmd /c """"" & dir & "\node.exe"" """ & dir & "\app\launcher.js"" >>""" & logDir & "\HomeLibrary.log"" 2>&1"""
shell.Run cmd, 0, False
