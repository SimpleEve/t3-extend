import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadBookmarkLabel, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { useBookmarkSources, useThreadBookmarks } from "./threadBookmarkState";

type ThreadBookmarksRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const LABEL_LENGTH = 80;

// fork: message bookmarks. The phone only reads them; adding and editing happen on the web client.
export function ThreadBookmarksRouteScreen(props: ThreadBookmarksRouteScreenProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const threadRef = scopeThreadRef(
    EnvironmentId.make(props.route.params.environmentId),
    ThreadId.make(props.route.params.threadId),
  );
  const bookmarks = useThreadBookmarks(threadRef);
  const sources = useBookmarkSources(threadRef);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <View className="flex-1">
      <AppBar
        title={gt("Bookmarks")}
        onBack={() => {
          if (navigation.canGoBack()) navigation.goBack();
        }}
        hideBottomBorder
      />
      <ScreenContent>
        {bookmarks.length === 0 ? (
          <EmptyState
            title={gt("No bookmarks yet")}
            detail={gt("Bookmarks you add on the web or desktop app show up here.")}
          />
        ) : (
          <ScreenScrollView contentContainerClassName="gap-5 px-4 py-4">
            <ListSection title={gt("Bookmarks · {count}", { count: bookmarks.length })}>
              {bookmarks.map((bookmark) => {
                const missing = sources.get(bookmark.id) === "missing";
                const expanded = expandedId === bookmark.id;
                return (
                  <View key={bookmark.id} className="px-3 py-1">
                    <View className="min-h-11 flex-row items-center gap-2">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={expanded ? gt("Show less") : gt("Show the full text")}
                        accessibilityState={{ expanded }}
                        hitSlop={8}
                        onPress={() => setExpandedId(expanded ? null : bookmark.id)}
                      >
                        <SymbolView
                          name={expanded ? "chevron.down" : "chevron.right"}
                          size={14}
                          tintColorClassName="accent-foreground-muted"
                        />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={missing}
                        onPress={() => {
                          requestThreadMessageJump(scopedThreadKey(threadRef), bookmark.messageId);
                          if (navigation.canGoBack()) navigation.goBack();
                        }}
                        className="min-w-0 flex-1 py-2"
                      >
                        <Text
                          textRole="label"
                          className={missing ? "text-foreground-muted" : "font-t3-medium"}
                          numberOfLines={expanded ? undefined : 2}
                        >
                          {threadBookmarkLabel(bookmark, LABEL_LENGTH)}
                        </Text>
                        {missing ? (
                          <Text textRole="label" className="text-foreground-muted">
                            {gt("The original message is no longer in this thread")}
                          </Text>
                        ) : null}
                      </Pressable>
                    </View>
                    {expanded ? (
                      <View className="gap-2 pb-2 ps-6">
                        <Text selectable textRole="body" className="text-foreground-muted">
                          {bookmark.excerpt}
                        </Text>
                        {bookmark.note ? (
                          <Text selectable textRole="body">
                            {bookmark.note}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ListSection>
          </ScreenScrollView>
        )}
      </ScreenContent>
    </View>
  );
}
