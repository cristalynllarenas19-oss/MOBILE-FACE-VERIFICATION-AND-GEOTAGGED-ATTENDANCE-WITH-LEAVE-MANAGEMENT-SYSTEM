import React, { useState } from "react";
import {
  SafeAreaView,
  View,
} from "react-native";

import AttendanceScreen from "./AttendanceScreen";
import LeaveScreen from "./LeaveScreen";
import DTRScreen from "./DTRScreen";
import SettingsScreen from "./SettingsScreen";

import Header from "../components/Header";
import BottomTab from "../components/BottomTab";

import { Tab } from "../types";

type Props = {
  user: any;
  onLogout: () => void;
  onTimeIn: () => void;
  onTimeOut: () => void;
  isLoading: boolean;
};

export default function MainScreen({
  user,
  onLogout,
  onTimeIn,
  onTimeOut,
  isLoading,
}: Props) {
  const [tab, setTab] =
    useState<Tab>("attendance");

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Header user={user} />

      <View
        style={{
          flex: 1,
          padding: 16,
        }}
      >
        {tab === "attendance" && (
          <AttendanceScreen
            isLoading={isLoading}
            onTimeIn={onTimeIn}
            onTimeOut={onTimeOut}
          />
        )}

        {tab === "leave" && (
          <LeaveScreen />
        )}

        {tab === "dtr" && (
          <DTRScreen />
        )}

        {tab === "settings" && (
          <SettingsScreen
            onLogout={onLogout}
          />
        )}
      </View>

      <BottomTab
        tab={tab}
        setTab={setTab}
      />
    </SafeAreaView>
  );
}