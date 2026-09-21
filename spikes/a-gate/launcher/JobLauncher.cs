// A-gate prototype of the JevCode launcher helper (design v0.3, section 6.3).
//
// Starts a command suspended, assigns it to a fresh Job Object with
// KILL_ON_JOB_CLOSE (no breakaway), resumes it, and keeps writing the set of
// PIDs ever seen in the job to a state file. After the main process exits the
// job gets `lingerMs` to drain before TerminateJobObject; `timeoutMs` bounds the
// whole run. If this launcher itself dies, the OS closes the job handle and
// kills every process still in the job.
//
// Usage: JobLauncher.exe <stateFile> <timeoutMs> <lingerMs> -- <exe> [args...]
// Exit:  main exit code if the job drained, 3 if processes survived, 2 on usage/setup errors.
//
// Build: csc.exe /nologo /optimize /out:JobLauncher.exe JobLauncher.cs   (.NET Framework 4, C# 5)

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class JobLauncher
{
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmdLine, IntPtr pa, IntPtr ta, bool inheritHandles,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);

    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint CREATE_SUSPENDED = 0x4;
    const int STARTF_USESTDHANDLES = 0x100;
    const int MaxPids = 4096;
    const int DrainAfterTerminateMs = 10000;

    static int Main(string[] args)
    {
        int sep = Array.IndexOf(args, "--");
        int timeoutMs, lingerMs;
        if (sep != 3 || args.Length < 5 || !int.TryParse(args[1], out timeoutMs) || !int.TryParse(args[2], out lingerMs))
        {
            Console.Error.WriteLine("usage: JobLauncher <stateFile> <timeoutMs> <lingerMs> -- <exe> [args...]");
            return 2;
        }
        string stateFile = args[0];

        var cmdLine = new StringBuilder();
        for (int i = sep + 1; i < args.Length; i++)
        {
            if (cmdLine.Length > 0) cmdLine.Append(' ');
            cmdLine.Append(QuoteArg(args[i]));
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return Fail("CreateJobObject");

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)))
            return Fail("SetInformationJobObject");

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);

        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi))
            return Fail("CreateProcess");
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            TerminateProcess(pi.hProcess, 1);
            return Fail("AssignProcessToJobObject");
        }
        ResumeThread(pi.hThread);

        var seen = new SortedSet<int>();
        DateTime start = DateTime.UtcNow;
        DateTime? mainExitedAt = null;
        DateTime? terminatedAt = null;
        uint mainExit = 0;
        string terminatedBy = "none";
        int active;

        while (true)
        {
            active = QueryPids(job, seen);
            DateTime now = DateTime.UtcNow;

            if (!mainExitedAt.HasValue && WaitForSingleObject(pi.hProcess, 0) == 0)
            {
                GetExitCodeProcess(pi.hProcess, out mainExit);
                mainExitedAt = now;
            }

            WriteState(stateFile, pi.dwProcessId, mainExitedAt.HasValue ? (long?)mainExit : null,
                mainExitedAt, start, terminatedBy, active, seen, false);

            if (active == 0) break;

            if (!terminatedAt.HasValue)
            {
                bool timedOut = (now - start).TotalMilliseconds > timeoutMs;
                bool lingered = mainExitedAt.HasValue && (now - mainExitedAt.Value).TotalMilliseconds > lingerMs;
                if (timedOut || lingered)
                {
                    TerminateJobObject(job, 1);
                    terminatedBy = timedOut ? "timeout" : "linger";
                    terminatedAt = now;
                }
            }
            else if ((now - terminatedAt.Value).TotalMilliseconds > DrainAfterTerminateMs)
            {
                break;
            }
            Thread.Sleep(200);
        }

        if (!mainExitedAt.HasValue && WaitForSingleObject(pi.hProcess, 0) == 0)
        {
            GetExitCodeProcess(pi.hProcess, out mainExit);
            mainExitedAt = DateTime.UtcNow;
        }
        WriteState(stateFile, pi.dwProcessId, mainExitedAt.HasValue ? (long?)mainExit : null,
            mainExitedAt, start, terminatedBy, active, seen, true);
        return active == 0 ? (int)mainExit : 3;
    }

    // Returns the active process count and adds every listed PID to `seen`.
    static int QueryPids(IntPtr job, SortedSet<int> seen)
    {
        int size = 8 + IntPtr.Size * MaxPids;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf, size, IntPtr.Zero)) return -1;
            int assigned = Marshal.ReadInt32(buf, 0);
            int listed = Marshal.ReadInt32(buf, 4);
            for (int i = 0; i < listed; i++)
                seen.Add((int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64());
            return assigned;
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    static void WriteState(string path, int mainPid, long? mainExit, DateTime? mainExitedAt, DateTime start,
        string terminatedBy, int active, SortedSet<int> seen, bool final)
    {
        var sb = new StringBuilder();
        sb.Append("{\"launcherPid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
        sb.Append(",\"mainPid\":").Append(mainPid);
        sb.Append(",\"mainExitCode\":").Append(mainExit.HasValue ? mainExit.Value.ToString() : "null");
        sb.Append(",\"mainExitedAfterMs\":").Append(mainExitedAt.HasValue
            ? ((long)(mainExitedAt.Value - start).TotalMilliseconds).ToString() : "null");
        sb.Append(",\"terminatedBy\":\"").Append(terminatedBy).Append('"');
        sb.Append(",\"activeProcesses\":").Append(active);
        sb.Append(",\"seenPids\":[").Append(string.Join(",", seen)).Append(']');
        sb.Append(",\"final\":").Append(final ? "true" : "false").Append('}');
        try
        {
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, sb.ToString());
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
        catch (IOException)
        {
            // Reader holds the file; the next tick rewrites it.
        }
    }

    // Windows argv quoting (inverse of CommandLineToArgvW).
    static string QuoteArg(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', backslashes * 2 + 1).Append('"'); backslashes = 0; continue; }
            sb.Append('\\', backslashes).Append(c);
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2).Append('"');
        return sb.ToString();
    }

    static int Fail(string what)
    {
        Console.Error.WriteLine(what + " failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        return 2;
    }
}
