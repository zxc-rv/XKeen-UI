package bin

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	reTimeMihomo   = regexp.MustCompile(`time="([^"]+)"`)
	reLevelMihomo  = regexp.MustCompile(`level=(\w+)`)
	ansiRegex      = regexp.MustCompile(`\x1b\[\d+m`)
	levelRegex     = regexp.MustCompile(`(?i)\[(debug|info|warn|warning|error|fatal)\]`)
	ansiReplacer   = strings.NewReplacer(
		"\u001b[32m", `<span style="color: #00cc00;">`, "\u001b[92m", `<span style="color: #00cc00;">`,
		"\u001b[31m", `<span style="color: #ef4444;">`, "\u001b[91m", `<span style="color: #ef4444;">`,
		"\u001b[33m", `<span style="color: #f59e0b;">`, "\u001b[93m", `<span style="color: #f59e0b;">`,
		"\u001b[96m", `<span style="color: #8BCEF7;">`, "\u001b[0m", "</span>",
	)
	levelBadgeMap = map[string]string{
		"debug": "debug", "info": "info", "warn": "warn", "warning": "warn",
		"error": "error", "fatal": "fatal",
	}
	levelNormalizer = strings.NewReplacer(
		"[Info]", "[INFO]", "[info]", "[INFO]",
		"[Warning]", "[WARN]", "[warning]", "[WARN]",
		"[Error]", "[ERROR]", "[error]", "[ERROR]",
		"[Debug]", "[DEBUG]", "[debug]", "[DEBUG]",
		"[Fatal]", "[FATAL]", "[fatal]", "[FATAL]",
	)
)

func formatLevel(level string) string {
	l := strings.ToLower(level)
	if mapped, ok := levelBadgeMap[l]; ok {
		l = mapped
	}
	return fmt.Sprintf(`<span class="log-badge log-badge-%s" data-filter="%s">%s</span>`, l, strings.ToUpper(l), strings.ToUpper(l))
}

func ProcessLogLine(line string, tzOffset int) string {
	if line == "" { return "" }

	d := time.Duration(tzOffset) * time.Hour

	if reTimeMihomo.MatchString(line) {
		timeMatch := reTimeMihomo.FindStringSubmatch(line)
		levelMatch := reLevelMihomo.FindStringSubmatch(line)

		if len(timeMatch) > 1 && len(levelMatch) > 1 {
			ts := timeMatch[1]
			if tzOffset != 0 {
				if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
					ts = t.Add(d).Format("2006/01/02 15:04:05.000000")
				}
			} else if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
				ts = t.Format("2006/01/02 15:04:05.000000")
			}

			msgStart := strings.Index(line, `msg="`)
			msg := ""
			if msgStart != -1 {
				msg = line[msgStart+5:]
				if idx := strings.Index(msg, `"`); idx != -1 {
					msg = msg[:idx]
				}
			}

			line = fmt.Sprintf("%s [%s] %s", ts, strings.ToUpper(levelMatch[1]), msg)
		}
	} else if tzOffset != 0 {
		if len(line) > 19 && line[4] == '/' && line[13] == ':' {
			if t, err := time.Parse("2006/01/02 15:04:05", line[:19]); err == nil {
				line = t.Add(d).Format("2006/01/02 15:04:05") + line[19:]
			}
		}
	}

	content := ansiRegex.ReplaceAllString(ansiReplacer.Replace(line), "")
	content = levelRegex.ReplaceAllStringFunc(content, func(m string) string {
		clean := strings.Trim(m, "[] ")
		return formatLevel(clean)
	})

	return `<div class="log-line">` + content + `</div>`
}

func GetLogs(path string, query string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil { return nil, err }
	defer f.Close()
	var lines []string
	scanner := bufio.NewScanner(f)
	AppSettingsMutex.RLock()
	tz := AppSettings.TimezoneOffset
	AppSettingsMutex.RUnlock()

	if query == "" {
		stat, _ := f.Stat()
		if stat.Size() > 128000 {
			f.Seek(-128000, io.SeekEnd)
			scanner.Scan()
		}
		for scanner.Scan() {
			if l := ProcessLogLine(scanner.Text(), tz); l != "" {
				lines = append(lines, l)
			}
		}
		return lines, nil
	}

	keywords := strings.Split(query, "|")
	totalBytes := 0

	for scanner.Scan() {
		text := scanner.Text()
		normalized := levelNormalizer.Replace(text)
		match := false
		for _, k := range keywords {
			if k != "" && strings.Contains(normalized, k) {
				match = true
				break
			}
		}
		if match {
			l := ProcessLogLine(text, tz)
			if l != "" {
				lines = append(lines, l)
				totalBytes += len(text) + 1
				if totalBytes >= 128000 { break }
			}
		}
	}

	return lines, nil
}