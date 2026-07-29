package org.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class JSONParser {
    private final String source;
    private int offset;

    JSONParser(String source) {
        if (source == null) throw new IllegalArgumentException("null JSON");
        this.source = source;
    }

    Object parse() {
        Object value = value();
        whitespace();
        if (offset != source.length()) fail("trailing input");
        return value;
    }

    private Object value() {
        whitespace();
        if (offset >= source.length()) fail("missing value");
        char next = source.charAt(offset);
        if (next == '{') return object();
        if (next == '[') return array();
        if (next == '"') return string();
        if (next == 't') return literal("true", Boolean.TRUE);
        if (next == 'f') return literal("false", Boolean.FALSE);
        if (next == 'n') return literal("null", JSONObject.NULL);
        return number();
    }

    private Map<String, Object> object() {
        expect('{');
        LinkedHashMap<String, Object> result =
            new LinkedHashMap<String, Object>();
        whitespace();
        if (consume('}')) return result;
        while (true) {
            whitespace();
            if (offset >= source.length() || source.charAt(offset) != '"') {
                fail("object key must be a string");
            }
            String key = string();
            whitespace();
            expect(':');
            result.put(key, value());
            whitespace();
            if (consume('}')) return result;
            expect(',');
        }
    }

    private List<Object> array() {
        expect('[');
        ArrayList<Object> result = new ArrayList<Object>();
        whitespace();
        if (consume(']')) return result;
        while (true) {
            result.add(value());
            whitespace();
            if (consume(']')) return result;
            expect(',');
        }
    }

    private String string() {
        expect('"');
        StringBuilder result = new StringBuilder();
        while (offset < source.length()) {
            char value = source.charAt(offset++);
            if (value == '"') return result.toString();
            if (value == '\\') {
                if (offset >= source.length()) fail("incomplete escape");
                char escape = source.charAt(offset++);
                if (escape == '"' || escape == '\\' || escape == '/') {
                    result.append(escape);
                } else if (escape == 'b') {
                    result.append('\b');
                } else if (escape == 'f') {
                    result.append('\f');
                } else if (escape == 'n') {
                    result.append('\n');
                } else if (escape == 'r') {
                    result.append('\r');
                } else if (escape == 't') {
                    result.append('\t');
                } else if (escape == 'u') {
                    if (offset + 4 > source.length()) {
                        fail("incomplete unicode escape");
                    }
                    try {
                        result.append((char) Integer.parseInt(
                            source.substring(offset, offset + 4),
                            16
                        ));
                    } catch (NumberFormatException error) {
                        fail("invalid unicode escape");
                    }
                    offset += 4;
                } else {
                    fail("invalid escape");
                }
            } else {
                if (value < 0x20) fail("control character in string");
                result.append(value);
            }
        }
        fail("unterminated string");
        return null;
    }

    private Object number() {
        int start = offset;
        if (consume('-') && offset >= source.length()) fail("invalid number");
        if (consume('0')) {
            // A leading zero is complete unless a fraction/exponent follows.
        } else {
            digits();
        }
        boolean decimal = false;
        if (consume('.')) {
            decimal = true;
            digits();
        }
        if (consume('e') || consume('E')) {
            decimal = true;
            consume('+');
            consume('-');
            digits();
        }
        String raw = source.substring(start, offset);
        try {
            if (decimal) return Double.valueOf(raw);
            long value = Long.parseLong(raw);
            return value >= Integer.MIN_VALUE && value <= Integer.MAX_VALUE
                ? Integer.valueOf((int) value)
                : Long.valueOf(value);
        } catch (NumberFormatException error) {
            fail("invalid number");
            return null;
        }
    }

    private void digits() {
        int start = offset;
        while (
            offset < source.length()
                && source.charAt(offset) >= '0'
                && source.charAt(offset) <= '9'
        ) {
            offset += 1;
        }
        if (start == offset) fail("missing digits");
    }

    private Object literal(String expected, Object value) {
        if (!source.startsWith(expected, offset)) fail("invalid literal");
        offset += expected.length();
        return value;
    }

    private void whitespace() {
        while (offset < source.length()) {
            char value = source.charAt(offset);
            if (
                value != ' '
                    && value != '\n'
                    && value != '\r'
                    && value != '\t'
            ) {
                return;
            }
            offset += 1;
        }
    }

    private boolean consume(char expected) {
        if (offset < source.length() && source.charAt(offset) == expected) {
            offset += 1;
            return true;
        }
        return false;
    }

    private void expect(char expected) {
        if (!consume(expected)) fail("expected " + expected);
    }

    private void fail(String message) {
        throw new IllegalArgumentException(
            message + " at character " + offset
        );
    }
}
