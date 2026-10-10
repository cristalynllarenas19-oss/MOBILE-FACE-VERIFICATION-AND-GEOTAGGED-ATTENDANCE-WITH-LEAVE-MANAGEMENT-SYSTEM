import { ComponentType, PropsWithChildren } from "react";
import { ViewStyle } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

// The monorepo's hoisted root node_modules carries its own @types/react
// distinct from this app's local one, so TS sees gesture-handler's own
// (correctly declared) children prop as a foreign, incompatible type. Cast
// through this app's own PropsWithChildren instead of fighting the mismatch.
const GestureRootView = GestureHandlerRootView as ComponentType<PropsWithChildren<{ style?: ViewStyle }>>;

export default GestureRootView;
